/**
 * Zero-dependency RFC 6455 WebSocket protocol core, moved verbatim from
 * studio-server: framing (encode/decode), the connection state machine and
 * the generic upgrade endpoint. The Studio hub (studio-server.ts) layers its
 * snapshot/seek/broadcast protocol on top of these primitives.
 */
import * as crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { IncomingMessage, Server } from 'node:http';

// ---------------------------------------------------------------------------
// RFC 6455 — the zero-dependency WebSocket protocol core
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export const CLOSE_NORMAL = 1000;
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_TOO_BIG = 1009;

/** Safety cap for one frame payload (and one fragmented message). */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * The RFC 6455 handshake response value for a `Sec-WebSocket-Key`:
 * base64(SHA-1(key + GUID)). Pinned by the RFC's own test vector.
 */
export function computeSecWebSocketAccept(key: string): string {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

export interface FrameEncodeOptions {
  /** FIN bit (default true). */
  fin?: boolean;
  /** Client frames MUST be masked; server frames MUST NOT be (default false). */
  mask?: boolean;
  /** Deterministic 4-byte mask key (default crypto-random) — for tests. */
  maskKey?: Buffer;
}

/**
 * Encode one WebSocket frame. Length tiers per RFC 6455 §5.2: ≤125 → 7-bit;
 * 126..65535 → 16-bit extended; ≥65536 → 64-bit extended.
 */
export function encodeFrame(opcode: number, payload: Buffer | string, opts: FrameEncodeOptions = {}): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
  const len = body.length;
  if (len > MAX_PAYLOAD_BYTES) throw new Error(`frame payload ${len} exceeds the ${MAX_PAYLOAD_BYTES} byte cap`);

  const fin = opts.fin ?? true;
  const mask = opts.mask ?? false;
  const extLen = len > 65535 ? 8 : len > 125 ? 2 : 0;
  const headerSize = 2 + extLen + (mask ? 4 : 0);
  const frame = Buffer.allocUnsafe(headerSize + len);

  frame[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  frame[1] = (mask ? 0x80 : 0) | (extLen === 8 ? 127 : extLen === 2 ? 126 : len);
  if (extLen === 2) frame.writeUInt16BE(len, 2);
  if (extLen === 8) frame.writeBigUInt64BE(BigInt(len), 2);
  if (mask) {
    const key = opts.maskKey && opts.maskKey.length === 4 ? opts.maskKey : crypto.randomBytes(4);
    key.copy(frame, 2 + extLen);
    for (let i = 0; i < len; i++) frame[headerSize + i] = body[i]! ^ key[i % 4]!;
  } else {
    body.copy(frame, headerSize);
  }
  return frame;
}

export interface DecodedFrame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

export interface DecodeResult {
  frames: DecodedFrame[];
  /** Unconsumed trailing bytes — the torn/tail part of an incomplete frame. */
  rest: Buffer;
  /** Protocol violation description (RSV bits set, oversized payload). */
  error?: string;
}

/**
 * Incremental frame parser: consumes every COMPLETE frame at the front of
 * `buffer` and returns the unconsumed tail. Tearing (one frame split across
 * TCP chunks) and sticking (several frames in one chunk) are both handled by
 * construction — incomplete prefixes land in `rest` and are re-parsed when the
 * next chunk arrives.
 */
export function decodeFrames(buffer: Buffer, maxPayload = MAX_PAYLOAD_BYTES): DecodeResult {
  const frames: DecodedFrame[] = [];
  let offset = 0;
  for (;;) {
    const remaining = buffer.length - offset;
    if (remaining < 2) break;
    const b0 = buffer[offset]!;
    const b1 = buffer[offset + 1]!;
    if ((b0 & 0x70) !== 0) return { frames, rest: buffer.subarray(offset), error: 'nonzero RSV bits' };
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    const len7 = b1 & 0x7f;
    const extLen = len7 === 127 ? 8 : len7 === 126 ? 2 : 0;
    let headerSize = 2 + extLen + (masked ? 4 : 0);
    let payloadLen = len7;
    if (len7 === 126) {
      if (remaining < 4) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
    } else if (len7 === 127) {
      if (remaining < 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(maxPayload)) {
        return { frames, rest: buffer.subarray(offset), error: `payload ${big} exceeds the ${maxPayload} byte cap` };
      }
      payloadLen = Number(big);
    }
    if (payloadLen > maxPayload) {
      return { frames, rest: buffer.subarray(offset), error: `payload ${payloadLen} exceeds the ${maxPayload} byte cap` };
    }
    if (remaining < headerSize) break; // extended length or mask key still torn
    if (remaining < headerSize + payloadLen) break; // payload still torn

    let payload: Buffer;
    if (masked) {
      const keyOffset = offset + 2 + extLen;
      const bodyOffset = offset + headerSize;
      payload = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = buffer[bodyOffset + i]! ^ buffer[keyOffset + (i % 4)]!;
      }
    } else {
      payload = Buffer.from(buffer.subarray(offset + headerSize, offset + headerSize + payloadLen));
    }
    frames.push({ fin, opcode, masked, payload });
    offset += headerSize + payloadLen;
  }
  return { frames, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// The connection state machine
// ---------------------------------------------------------------------------

/** A single upgraded WebSocket connection: framing in, messages out. */
export class WebSocketConnection {
  /** Text-message callback (client data frames are masked per RFC). */
  onText?: (conn: WebSocketConnection, text: string) => void;
  /** Fires once when the socket drops or a close was completed. */
  onClose?: (conn: WebSocketConnection) => void;

  readonly socket: Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private fragmentOpcode: number | null = null;
  private fragments: Buffer[] = [];
  private closed = false;

  constructor(socket: Duplex, head: Buffer = Buffer.alloc(0)) {
    this.socket = socket;
    (socket as unknown as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
    socket.on('close', () => this.teardown());
    socket.on('error', () => this.teardown());
    // http.Server sockets are allowHalfOpen:true — a peer FIN fires 'end' but
    // would leave the socket half-open forever (server.close() then never
    // drains). A half-closed WS session is over: destroy the socket.
    socket.on('end', () => {
      this.teardown();
      socket.destroy();
    });
    if (head.length > 0) this.consume(head);
  }

  /** True once a close frame was sent or the socket dropped. */
  get isClosed(): boolean {
    return this.closed;
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { frames, rest, error } = decodeFrames(this.buffer);
    this.buffer = rest;
    if (error) {
      this.fail(CLOSE_PROTOCOL_ERROR, error);
      return;
    }
    for (const frame of frames) this.handleFrame(frame);
  }

  private handleFrame(frame: DecodedFrame): void {
    switch (frame.opcode) {
      case OP_CLOSE:
        // Echo the close handshake, then drop the TCP connection.
        if (!this.closed) {
          this.closed = true;
          this.rawSend(encodeFrame(OP_CLOSE, frame.payload.length >= 2 ? frame.payload.subarray(0, 2) : Buffer.alloc(0)));
        }
        this.socket.destroy();
        this.teardown();
        return;
      case OP_PING:
        if (frame.payload.length > 125 || !frame.fin) {
          this.fail(CLOSE_PROTOCOL_ERROR, 'invalid ping frame');
          return;
        }
        this.rawSend(encodeFrame(OP_PONG, frame.payload));
        return;
      case OP_PONG:
        return; // unsolicited pongs are acks; nothing to do
      case OP_TEXT:
      case OP_BINARY: {
        if (!frame.masked) {
          this.fail(CLOSE_PROTOCOL_ERROR, 'client data frames must be masked');
          return;
        }
        if (this.fragmentOpcode !== null) {
          this.fail(CLOSE_PROTOCOL_ERROR, 'new data frame during fragmentation');
          return;
        }
        if (frame.fin) {
          if (frame.opcode === OP_TEXT) this.deliverText(frame.payload);
          return; // binary frames are accepted but carry no studio semantics
        }
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
        return;
      }
      case OP_CONTINUATION: {
        if (this.fragmentOpcode === null) {
          this.fail(CLOSE_PROTOCOL_ERROR, 'continuation without a fragmented message');
          return;
        }
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const opcode = this.fragmentOpcode;
          const message = Buffer.concat(this.fragments);
          this.fragmentOpcode = null;
          this.fragments = [];
          if (opcode === OP_TEXT) this.deliverText(message);
        }
        return;
      }
      default:
        this.fail(CLOSE_PROTOCOL_ERROR, `unknown opcode ${frame.opcode}`);
    }
  }

  private deliverText(payload: Buffer): void {
    const text = payload.toString('utf-8');
    try {
      this.onText?.(this, text);
    } catch {
      /* a handler bug must never kill the connection mid-stream */
    }
  }

  /** Send one text frame (FIN, unmasked) — server frames are never masked. */
  sendText(text: string): void {
    if (this.closed) return;
    this.rawSend(encodeFrame(OP_TEXT, text));
  }

  /** Send a ping control frame (≤125 bytes). */
  sendPing(payload: Buffer | string = ''): void {
    if (this.closed) return;
    this.rawSend(encodeFrame(OP_PING, payload));
  }

  /** Send a pong control frame (≤125 bytes). */
  sendPong(payload: Buffer | string = ''): void {
    if (this.closed) return;
    this.rawSend(encodeFrame(OP_PONG, payload));
  }

  /** Begin the close handshake (code 1000 default) — the peer may echo then drop. */
  sendClose(code = CLOSE_NORMAL, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    const body = Buffer.alloc(2 + Math.min(reason.length, 123));
    body.writeUInt16BE(code, 0);
    if (reason) body.write(reason, 2, 'utf-8');
    this.rawSend(encodeFrame(OP_CLOSE, body));
  }

  /** Protocol failure: close with the given code, then destroy unconditionally. */
  private fail(code: number, reason: string): void {
    this.sendClose(code, reason.slice(0, 120));
    this.socket.destroy();
    this.teardown();
  }

  private rawSend(frame: Buffer): void {
    try {
      this.socket.write(frame);
    } catch {
      this.teardown();
    }
  }

  private teardown(): void {
    const wasOpen = !this.closed;
    this.closed = true;
    this.fragmentOpcode = null;
    this.fragments = [];
    if (wasOpen) {
      try {
        this.onClose?.(this);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The generic endpoint + the studio hub
// ---------------------------------------------------------------------------

export interface WebSocketEndpointOptions {
  /** Required URL path for the upgrade (default: any path upgrades). */
  path?: string;
  /** Called after the 101 handshake with the new connection. */
  onConnection?: (conn: WebSocketConnection) => void;
  /** Called for each complete client TEXT message. */
  onText?: (conn: WebSocketConnection, text: string) => void;
  /** Reject upgrades that fail validation with this HTTP status (default 400). */
  rejectStatus?: number;
  /**
   * Issue #143: extra handshake gate — return an error message to reject the
   * upgrade with 403, or null to accept. Runs after the RFC 6455 checks.
   */
  verifyRequest?: (req: IncomingMessage) => string | null;
}

export interface WebSocketEndpoint {
  /** Detach the upgrade listener (open sockets stay open). */
  detach: () => void;
}

/**
 * Attach a zero-dependency RFC 6455 WebSocket endpoint to an existing
 * node:http server via its `upgrade` event. Handshake validation: GET method,
 * `Upgrade: websocket`, a `Sec-WebSocket-Key`, version 13 — anything else is
 * rejected with `rejectStatus` and the socket destroyed.
 */
export function attachWebSocketEndpoint(server: Server, opts: WebSocketEndpointOptions = {}): WebSocketEndpoint {
  const rejectStatus = opts.rejectStatus ?? 400;
  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    const version = String(req.headers['sec-websocket-version'] ?? '');
    if (req.method !== 'GET' || upgrade !== 'websocket' || typeof key !== 'string' || !key || version !== '13') {
      rejectUpgrade(socket, rejectStatus, 'expected an RFC 6455 websocket handshake');
      return;
    }
    if (opts.path) {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname !== opts.path) {
        rejectUpgrade(socket, 404, `websocket endpoint is ${opts.path}`);
        return;
      }
    }
    if (opts.verifyRequest) {
      const verdict = opts.verifyRequest(req);
      if (verdict) {
        rejectUpgrade(socket, 403, verdict);
        return;
      }
    }
    const accept = computeSecWebSocketAccept(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    );
    const conn = new WebSocketConnection(socket, head);
    if (opts.onText) conn.onText = (c, text) => opts.onText?.(c, text);
    opts.onConnection?.(conn);
  };
  server.on('upgrade', handleUpgrade);
  return { detach: () => server.removeListener('upgrade', handleUpgrade) };
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} \r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
}

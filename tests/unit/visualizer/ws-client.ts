/**
 * Minimal raw-socket WebSocket test client (tests only — never shipped): it
 * performs the RFC 6455 upgrade handshake against a real port and reuses the
 * PRODUCTION codec (decodeFrames / encodeFrame) on both sides of the wire, so
 * a bug in the frame encoder cannot hide behind a hand-rolled test decoder.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  decodeFrames,
  encodeFrame,
  OP_TEXT,
  type DecodedFrame,
} from '../../../src/visualizer/studio-server.js';

export interface RejectionError extends Error {
  statusCode: number;
  body: string;
}

export class TestWsClient {
  readonly socket: Duplex;
  readonly handshake: IncomingMessage;
  private buf: Buffer;
  private readonly frames: DecodedFrame[] = [];
  private consumed = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(handshake: IncomingMessage, socket: Duplex, head: Buffer) {
    this.handshake = handshake;
    this.socket = socket;
    this.buf = Buffer.from(head);
    socket.on('data', (chunk: Buffer) => this.ingest(chunk));
    if (this.buf.length > 0) this.ingest(Buffer.alloc(0));
  }

  private ingest(chunk: Buffer): void {
    if (chunk.length > 0) this.buf = Buffer.concat([this.buf, chunk]);
    const { frames, rest } = decodeFrames(this.buf);
    this.buf = rest;
    this.frames.push(...frames);
    if (frames.length > 0) this.flush();
  }

  private flush(): void {
    while (this.waiters.length > 0 && this.frames.length > this.consumed) this.waiters.shift()!();
  }

  /** Next complete frame from the server (FIFO), rejecting on timeout. */
  nextFrame(timeoutMs = 4000): Promise<DecodedFrame> {
    if (this.frames.length > this.consumed) return Promise.resolve(this.frames[this.consumed++]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for a WS frame (${this.frames.length - this.consumed} queued)`)),
        timeoutMs,
      );
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(this.frames[this.consumed++]!);
      });
    });
  }

  /** Next complete TEXT frame parsed as JSON. */
  async nextJson(timeoutMs = 4000): Promise<Record<string, unknown>> {
    const frame = await this.nextFrame(timeoutMs);
    if (frame.opcode !== OP_TEXT) throw new Error(`expected a text frame, got opcode ${frame.opcode}`);
    return JSON.parse(frame.payload.toString('utf-8')) as Record<string, unknown>;
  }

  /** Send one masked text frame (client frames MUST be masked). */
  sendText(text: string): void {
    this.socket.write(encodeFrame(OP_TEXT, text, { mask: true }));
  }

  /** Send one masked frame with an explicit opcode (control frames included). */
  sendMasked(opcode: number, payload: Buffer | string, opts: { fin?: boolean } = {}): void {
    this.socket.write(encodeFrame(opcode, payload, { mask: true, ...opts }));
  }

  /** Begin a normal close handshake (code 1000). */
  sendClose(code = 1000): void {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.sendMasked(0x8, body);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export interface ConnectWsOptions {
  /** Force a specific Sec-WebSocket-Key (for accept-value assertions). */
  key?: string;
  /** Omit the Sec-WebSocket-Key header entirely (handshake rejection test). */
  omitKey?: boolean;
  version?: string;
  headers?: Record<string, string>;
}

/**
 * Perform a real HTTP Upgrade handshake against `port`. Resolves with the
 * connected client on 101; rejects with `statusCode`/`body` when the server
 * refuses the upgrade.
 */
export async function connectWs(port: number, path = '/ws', opts: ConnectWsOptions = {}): Promise<TestWsClient> {
  const key = opts.key ?? crypto.randomBytes(16).toString('base64');
  const headers: Record<string, string> = {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': opts.version ?? '13',
    ...(opts.omitKey ? {} : { 'sec-websocket-key': key }),
    ...opts.headers,
  };
  return await new Promise<TestWsClient>((resolve, reject) => {
    // agent:false — a WebSocket client never reuses a pooled keep-alive socket;
    // the default agent poisons the pool across server-destroyed rejections.
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent: false });
    req.on('upgrade', (res, socket, head) => resolve(new TestWsClient(res, socket, head)));
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c: Buffer) => {
        body += c.toString();
      });
      res.on('end', () => {
        const err = new Error(`upgrade rejected with ${res.statusCode}`) as RejectionError;
        err.statusCode = res.statusCode ?? 0;
        err.body = body;
        reject(err);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

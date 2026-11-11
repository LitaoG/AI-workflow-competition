/**
 * RFC 6455 protocol-core tests (Issue #156): handshake accept computation,
 * frame encoding length tiers (125 / 126 / 127), masking, fragmentation with
 * interleaved control frames, close/ping/pong, and tear/stick parsing — plus
 * real-socket handshake and rejection paths against a live http server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  attachWebSocketEndpoint,
  computeSecWebSocketAccept,
  decodeFrames,
  encodeFrame,
  OP_BINARY,
  OP_CLOSE,
  OP_CONTINUATION,
  OP_PING,
  OP_PONG,
  OP_TEXT,
  CLOSE_PROTOCOL_ERROR,
  type WebSocketConnection,
} from '../../../src/visualizer/studio-server.js';
import { connectWs, type RejectionError } from './ws-client.js';

interface RunningEndpoint {
  port: number;
  endpoint: { detach: () => void };
  server: http.Server;
  texts: string[];
  close: () => Promise<void>;
}

async function startEndpoint(): Promise<RunningEndpoint> {
  const texts: string[] = [];
  const server = http.createServer(() => {});
  const endpoint = attachWebSocketEndpoint(server, {
    path: '/ws',
    onText: (_conn: WebSocketConnection, text: string) => texts.push(text),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    endpoint,
    server,
    texts,
    close: async () => {
      endpoint.detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Pure codec tests
// ---------------------------------------------------------------------------

test('handshake: Sec-WebSocket-Accept matches the RFC 6455 section 1.3 vector', () => {
  // The RFC's own worked example — key "the sample nonce" base64-encoded.
  assert.equal(computeSecWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame: 125-byte payload uses the 7-bit length tier', () => {
  const payload = Buffer.alloc(125, 0x61);
  const frame = encodeFrame(OP_TEXT, payload);
  assert.equal(frame.length, 127, '2 header bytes + 125 payload');
  assert.equal(frame[0], 0x81, 'FIN + text opcode');
  assert.equal(frame[1]! & 0x7f, 125, '7-bit length directly in byte 1');
  const { frames, rest } = decodeFrames(frame);
  assert.equal(rest.length, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.payload.length, 125);
});

test('encodeFrame: 126..65535 payloads use the 16-bit extended length tier', () => {
  for (const len of [126, 300, 65535]) {
    const frame = encodeFrame(OP_TEXT, Buffer.alloc(len));
    assert.equal(frame.length, 4 + len, `tier-2 header for ${len}`);
    assert.equal(frame[1]! & 0x7f, 126, '0x7E marks the 16-bit tier');
    assert.equal(frame.readUInt16BE(2), len);
  }
});

test('encodeFrame: 65536+ payloads use the 64-bit extended length tier', () => {
  const len = 65536;
  const frame = encodeFrame(OP_BINARY, Buffer.alloc(len));
  assert.equal(frame.length, 10 + len, '10 header bytes for the 64-bit tier');
  assert.equal(frame[1]! & 0x7f, 127, '0x7F marks the 64-bit tier');
  assert.equal(frame.readBigUInt64BE(2), BigInt(len));
  const { frames } = decodeFrames(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.payload.length, len);
});

test('encodeFrame/decodeFrames: masked payload roundtrips byte-exactly', () => {
  const payload = Buffer.from('masked payload with a \\0 null byte');
  const frame = encodeFrame(OP_TEXT, payload, { mask: true, maskKey: Buffer.from([0x01, 0x02, 0x03, 0x04]) });
  assert.equal(frame[1]! & 0x80, 0x80, 'MASK bit set');
  const { frames } = decodeFrames(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.masked, true);
  assert.ok(frames[0]!.payload.equals(payload), 'unmasked payload equals the original');
});

test('decodeFrames: two frames stuck in one chunk parse as two frames', () => {
  const stuck = Buffer.concat([encodeFrame(OP_TEXT, 'first'), encodeFrame(OP_TEXT, 'second frame')]);
  const { frames, rest } = decodeFrames(stuck);
  assert.equal(rest.length, 0);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.payload.toString('utf-8'), 'first');
  assert.equal(frames[1]!.payload.toString('utf-8'), 'second frame');
});

test('decodeFrames: a frame torn across two chunks reassembles from the tail', () => {
  const frame = encodeFrame(OP_TEXT, 'torn-across-chunks');
  const cut = 6;
  const first = decodeFrames(frame.subarray(0, cut));
  assert.equal(first.frames.length, 0, 'nothing complete yet');
  assert.ok(first.rest.length > 0 && first.rest.length === cut, 'torn bytes retained');
  const second = decodeFrames(Buffer.concat([first.rest, frame.subarray(cut)]));
  assert.equal(second.frames.length, 1);
  assert.equal(second.frames[0]!.payload.toString('utf-8'), 'torn-across-chunks');
  assert.equal(second.rest.length, 0);
});

test('decodeFrames: an 8-byte length header torn mid-header stays pending', () => {
  const torn = Buffer.from([0x82, 0x7f, 0x00, 0x00, 0x00]);
  const { frames, rest } = decodeFrames(torn);
  assert.equal(frames.length, 0);
  assert.equal(rest.length, torn.length);
});

test('decodeFrames: nonzero RSV bits are a protocol error', () => {
  const bad = Buffer.from([0x41, 0x00]); // RSV1 set on a text frame
  const { error } = decodeFrames(bad);
  assert.match(error ?? '', /RSV/);
});

test('decodeFrames: payloads beyond the cap are rejected (both length tiers)', () => {
  // 64-bit tier declaring an absurd payload.
  const absurd = Buffer.alloc(10);
  absurd[0] = 0x81;
  absurd[1] = 0x7f;
  absurd.writeBigUInt64BE(BigInt('0xFFFFFFFFFFFF'), 2);
  assert.match(decodeFrames(absurd).error ?? '', /exceeds/);
  // A normal 6-byte payload against a 5-byte custom cap.
  const small = encodeFrame(OP_TEXT, 'abcdef');
  assert.match(decodeFrames(small, 5).error ?? '', /exceeds/);
});

// ---------------------------------------------------------------------------
// Real-socket handshake + control frames
// ---------------------------------------------------------------------------

test('handshake: real upgrade returns 101 with the computed accept value', async () => {
  const ep = await startEndpoint();
  try {
    const key = 'AAAAAAAAAAAAAAAAAAAAAA==';
    const client = await connectWs(ep.port, '/ws', { key });
    try {
      assert.equal(client.handshake.statusCode, 101);
      assert.equal(String(client.handshake.headers.upgrade).toLowerCase(), 'websocket');
      assert.equal(client.handshake.headers['sec-websocket-accept'], computeSecWebSocketAccept(key));
    } finally {
      client.destroy();
    }
  } finally {
    await ep.close();
  }
});

test('handshake: missing key, bad version and wrong path are rejected', async () => {
  const ep = await startEndpoint();
  try {
    const noKey = (await connectWs(ep.port, '/ws', { omitKey: true }).catch((e: RejectionError) => e)) as RejectionError;
    assert.equal(noKey.statusCode, 400);
    const badVersion = (await connectWs(ep.port, '/ws', { version: '12' }).catch((e: RejectionError) => e)) as RejectionError;
    assert.equal(badVersion.statusCode, 400);
    const wrongPath = (await connectWs(ep.port, '/not-ws').catch((e: RejectionError) => e)) as RejectionError;
    assert.equal(wrongPath.statusCode, 404);
  } finally {
    await ep.close();
  }
});

test('ping is answered with a pong carrying the same application payload', async () => {
  const ep = await startEndpoint();
  try {
    const client = await connectWs(ep.port);
    try {
      client.sendMasked(OP_PING, 'abc');
      const pong = await client.nextFrame();
      assert.equal(pong.opcode, OP_PONG);
      assert.equal(pong.payload.toString('utf-8'), 'abc');
    } finally {
      client.destroy();
    }
  } finally {
    await ep.close();
  }
});

test('close is echoed with the same code and the socket ends', async () => {
  const ep = await startEndpoint();
  try {
    const client = await connectWs(ep.port);
    client.sendClose(1000);
    const close = await client.nextFrame();
    assert.equal(close.opcode, OP_CLOSE);
    assert.equal(close.payload.length >= 2 ? close.payload.readUInt16BE(0) : -1, 1000);
    const ended = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 2000);
      client.socket.on('close', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    assert.ok(ended, 'server dropped the TCP connection after the close handshake');
    await ep.close();
  } catch (err) {
    await ep.close();
    throw err;
  }
});

test('text messages reach the endpoint handler', async () => {
  const ep = await startEndpoint();
  try {
    const client = await connectWs(ep.port);
    try {
      client.sendText('hello endpoint');
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(ep.texts, ['hello endpoint']);
    } finally {
      client.destroy();
    }
  } finally {
    await ep.close();
  }
});

test('fragmented text (fin=false + continuation fin=true) reassembles in order', async () => {
  const ep = await startEndpoint();
  try {
    const client = await connectWs(ep.port);
    try {
      client.sendMasked(OP_TEXT, 'frag-', { fin: false });
      client.sendMasked(OP_CONTINUATION, 'ment', { fin: false });
      client.sendMasked(OP_CONTINUATION, 'ed!', { fin: true });
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(ep.texts, ['frag-mented!']);
    } finally {
      client.destroy();
    }
  } finally {
    await ep.close();
  }
});

test('a control frame between fragments is answered AND does not corrupt the message', async () => {
  const ep = await startEndpoint();
  try {
    const client = await connectWs(ep.port);
    try {
      client.sendMasked(OP_TEXT, 'A', { fin: false });
      client.sendMasked(OP_PING, 'mid');
      client.sendMasked(OP_CONTINUATION, 'B', { fin: true });
      const pong = await client.nextFrame();
      assert.equal(pong.opcode, OP_PONG);
      assert.equal(pong.payload.toString('utf-8'), 'mid');
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(ep.texts, ['AB'], 'control frames must never merge into the data message');
    } finally {
      client.destroy();
    }
  } finally {
    await ep.close();
  }
});

test('continuation without a fragmented message fails the connection with 1002', async () => {
  const ep = await startEndpoint();
  try {
    const client = await connectWs(ep.port);
    client.sendMasked(OP_CONTINUATION, 'orphan', { fin: true });
    const close = await client.nextFrame();
    assert.equal(close.opcode, OP_CLOSE);
    assert.equal(close.payload.readUInt16BE(0), CLOSE_PROTOCOL_ERROR);
    await ep.close();
  } catch (err) {
    await ep.close();
    throw err;
  }
});

test('unmasked client data frames fail the connection with 1002', async () => {
  const ep = await startEndpoint();
  try {
    const client = await connectWs(ep.port);
    client.socket.write(encodeFrame(OP_TEXT, 'naked')); // no mask — servers must fail this
    const close = await client.nextFrame();
    assert.equal(close.opcode, OP_CLOSE);
    assert.equal(close.payload.readUInt16BE(0), CLOSE_PROTOCOL_ERROR);
    await ep.close();
  } catch (err) {
    await ep.close();
    throw err;
  }
});

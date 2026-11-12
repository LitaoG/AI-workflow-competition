/**
 * (Issue #155): the NDJSON wire-format contract between
 * the dwf engine and its child realm (src/dwf/protocol.ts encodeFrame; the
 * runner's inline frame pump is the consumer). The pump's incremental
 * behavior assumes exactly one property, and this locks it as a format law:
 *
 *   A frame is exactly one '\n'-terminated JSON line — so any concatenation
 *   of frames can be re-parsed from ANY chunking of the stream (tearing,
 *   coalescing, one-byte drips) back into the original frame sequence.
 *
 * Pure test增量: the implementation is untouched.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fc from 'fast-check';

import { encodeFrame } from '../../dist/src/dwf/protocol.js';

/**
 * JSON's wire format cannot express -0: JSON.stringify(-0) === "0", so
 * JSON.parse rounds it to 0 and the strict round-trip identity fails on any
 * generated -0 — a seed lottery, not a codec defect (Issue #171). The
 * generator excludes -0 so the properties state the TRANSPORT contract
 * (identity up to the wire's -0 normalization), not IEEE754 sign
 * preservation. The normalization itself is pinned as a format law below.
 */
function stripNegativeZero(value: unknown): unknown {
  if (Object.is(value, -0)) return 0;
  if (Array.isArray(value)) return value.map(stripNegativeZero);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripNegativeZero(v)]));
  }
  return value;
}

const jsonValueNoNegativeZero = fc.jsonValue().map(stripNegativeZero);


test('property: JSON.parse(encodeFrame(f)) is the identity on JSON values', () => {
  const prop = fc.property(jsonValueNoNegativeZero, (frame) => {
    const parsed = JSON.parse(encodeFrame(frame));
    assert.deepEqual(parsed, frame);
  });
  assert.equal(fc.assert(prop, { numRuns: 300 }), undefined);
});

test('format law: -0 normalizes to 0 across the wire (Issue #171)', () => {
  // The wire cannot distinguish -0 from 0 — pinned so a future codec change
  // cannot silently alter the normalization the generator above assumes.
  const parsed = JSON.parse(encodeFrame(-0));
  assert.ok(Object.is(parsed, 0), 'parsed -0 must be +0');
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(-0)));
});

test('property: a frame never contains a raw newline before its terminating one', () => {
  const prop = fc.property(jsonValueNoNegativeZero, (frame) => {
    const wire = encodeFrame(frame);
    assert.ok(wire.endsWith('\n'), 'the frame is newline-terminated');
    const body = wire.slice(0, -1);
    assert.ok(!body.includes('\n'), `the frame body must be one line, got: ${JSON.stringify(body.slice(0, 80))}`);
  });
  assert.equal(fc.assert(prop, { numRuns: 300 }), undefined);
});

test('property: any chunking of a concatenated frame stream re-parses to the original sequence', () => {
  const framesArb = fc.array(jsonValueNoNegativeZero, { minLength: 1, maxLength: 12 });
  const prop = fc.property(framesArb, fc.array(fc.nat({ max: 37 }), { maxLength: 64 }), (frames, cutHints) => {
    const stream = frames.map((f) => encodeFrame(f)).join('');

    // Deliver the stream through arbitrary chunk boundaries (tearing and
    // coalescing alike), extracting complete lines the way the pump does.
    const received: unknown[] = [];
    let buffer = '';
    let cursor = 0;
    const cuts = cutHints.length > 0 ? cutHints : [1];
    let ci = 0;
    while (cursor < stream.length) {
      const size = Math.min(Math.max(cuts[ci % cuts.length]!, 1), stream.length - cursor);
      buffer += stream.slice(cursor, cursor + size);
      cursor += size;
      ci++;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) received.push(JSON.parse(line));
      }
    }
    assert.equal(buffer, '', 'every byte of the stream lands in a complete frame');
    assert.deepEqual(received, frames, 'the frame sequence survives any chunking');
  });
  assert.equal(fc.assert(prop, { numRuns: 200 }), undefined);
});

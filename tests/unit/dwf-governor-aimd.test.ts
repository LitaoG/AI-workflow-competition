import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AimdGovernor } from '../../src/dwf/governor.js';

// Official AIMD semantics (docs/research/ZCODE-DEEP-REVERSE-v2.md §1.3, §5 P1-1):
// epoch batch damping + lastGood watermark, on top of the classic add/multiply/
// Retry-After/idle-reset behavior. Each test drives one fresh governor so buckets
// never leak between cases.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('epoch batch damping: a 429 from an older epoch never moves the cap', async () => {
  const g = new AimdGovernor({ maxPerProvider: 4, increaseAfter: 2 });
  const snap = () => g.snapshot().find((s) => s.providerId === 'p')!;

  await g.acquire('p');
  await g.acquire('p');
  await g.acquire('p');
  await g.acquire('p'); // four admissions at epoch 0
  g.release('p', 'failure'); // the batch's one verdict: 4 → 3, epoch 0 → 1
  assert.equal(snap().limit, 3);
  assert.equal(snap().epoch, 1);

  g.release('p', 'failure', 60); // batch-0 straggler: damped
  assert.equal(snap().limit, 3, 'old-epoch 429 leaves the cap alone');
  assert.equal(snap().epoch, 1, 'old-epoch 429 does not flip the epoch');
  assert.ok(snap().cooldownUntil > Date.now(), 'old-epoch 429 still records the Retry-After cooldown');
  assert.ok(snap().lastThrottledAt > 0, 'old-epoch 429 still marks lastThrottledAt');

  // Issue #37 layer 2 success-epoch discipline: old-epoch successes prove the
  // OLD (already cut) cap, not this one — they never count toward the streak.
  g.release('p', 'success'); // epoch-0 straggler
  g.release('p', 'success'); // epoch-0 straggler
  assert.equal(snap().limit, 3);
  assert.equal(snap().lastGood, undefined, 'old-epoch successes do not prove the current cap');

  await g.acquire('p'); // fresh admission at epoch 1 (waits out the 60ms cooldown)
  g.release('p', 'failure'); // same-epoch verdict again: floor(3 × 0.75) = 2
  assert.equal(snap().limit, 2, 'a new-epoch 429 judges the cap again');
  assert.equal(snap().epoch, 2);
});

test('lastGood watermark: above the proven watermark falls back to it, at or below it multiplies down', async () => {
  const g = new AimdGovernor({ maxPerProvider: 8, increaseAfter: 1 });
  const snap = () => g.snapshot().find((s) => s.providerId === 'p')!;

  // tier ② (no watermark yet): 8 → floor(8 × 0.75) = 6
  await g.acquire('p');
  g.release('p', 'failure');
  assert.equal(snap().limit, 6);
  assert.equal(snap().lastGood, undefined);

  // climb 6 → 7 → 8 with demand: each success completes a streak, and a parked
  // waiter is what authorises the +1
  for (let i = 0; i < 6; i++) await g.acquire('p');
  g.acquire('p'); // parks synchronously (bucket full)
  g.release('p', 'success'); // streak → lastGood=6, waiter present → limit=7
  await Promise.resolve(); // let the woken waiter take the freed slot
  assert.equal(snap().limit, 7);
  assert.equal(snap().lastGood, 6);

  await g.acquire('p');
  g.acquire('p'); // parks again (bucket full at 7)
  g.release('p', 'success'); // streak → lastGood=7, waiter present → limit=8
  await Promise.resolve();
  assert.equal(snap().limit, 8);
  assert.equal(snap().lastGood, 7);

  // tier ① (above the watermark): 8 falls back to lastGood=7, NOT floor(8 × 0.75) = 6
  g.release('p', 'failure');
  assert.equal(snap().limit, 7, 'cap above lastGood falls back to the watermark');
  assert.equal(snap().lastGood, 7, 'tier ① keeps the watermark');
  assert.equal(snap().epoch, 2);
});

test('multiplicative decrease floors the fractional product: 6 → 4 (4.5), 4 → 3 (exact)', async () => {
  const g = new AimdGovernor();
  const snap = () => g.snapshot().find((s) => s.providerId === 'q')!;

  await g.acquire('q');
  g.release('q', 'failure'); // 8 → 6
  assert.equal(snap().limit, 6);

  await g.acquire('q'); // fresh epoch-1 admission — a straggler would be damped instead
  g.release('q', 'failure'); // 6 → floor(4.5) = 4, not 5
  assert.equal(snap().limit, 4, 'fractional product rounds down');

  await g.acquire('q');
  g.release('q', 'failure'); // 4 → 3 exactly
  assert.equal(snap().limit, 3);
});

test('floor of 1: the cap never drops below one probe', async () => {
  const g = new AimdGovernor({ maxPerProvider: 2 });
  const snap = () => g.snapshot().find((s) => s.providerId === 'r')!;

  await g.acquire('r');
  g.release('r', 'failure'); // 2 → floor(1.5) = 1
  assert.equal(snap().limit, 1);

  await g.acquire('r');
  g.release('r', 'failure'); // max(1, floor(0.75)) = 1
  assert.equal(snap().limit, 1, 'cap clamped at 1');

  await g.acquire('r');
  g.release('r', 'failure');
  assert.equal(snap().limit, 1, 'still 1 after repeated verdicts');
});

test('idle reset: restores max, clears the cooldown, flips the epoch once — and never re-flips while a request is in flight', async () => {
  const g = new AimdGovernor({ maxPerProvider: 3, idleResetMinutes: 0 });
  const snap = () => g.snapshot().find((s) => s.providerId === 'p')!;

  await g.acquire('p');
  g.release('p', 'failure', 60_000); // 3 → 2 plus a pending 60s cooldown
  assert.equal(snap().limit, 2);
  assert.ok(snap().cooldownUntil > Date.now());

  await sleep(20); // idle stretch with nothing in flight (idleResetMs = 0)
  const before = snap().epoch;
  await g.acquire('p'); // the reset fires here, ahead of this admission
  const s = snap();
  assert.equal(s.limit, 3, 'idle reset restores the max cap');
  assert.equal(s.cooldownUntil, 0, 'idle reset clears the pending Retry-After cooldown');
  assert.equal(s.epoch, before + 1, 'idle reset flips the epoch exactly once');
  assert.equal(s.inFlight, 1, 'the reset preceded this admission');

  const epochAtRest = snap().epoch;
  await g.acquire('p'); // joins while the first is still in flight
  assert.equal(snap().epoch, epochAtRest, 'in-flight requests keep the idle reset from re-firing');
  assert.equal(snap().limit, 3);
});

// ---------------------------------------------------------------------------
// Issue #37: the four-layer discipline (canonical ConcurrencyController parity)
// ---------------------------------------------------------------------------

test('#37 layer 1: model-granular bucket keys — provider/model buckets are independent', async () => {
  const g = new AimdGovernor({ maxPerProvider: 4 });
  await g.acquire('p', { modelId: 'm1' });
  g.release('p', 'failure', { modelId: 'm1' }); // m1 bucket: 4 → 3
  await g.acquire('p', { modelId: 'm2' });
  g.release('p', 'success', { modelId: 'm2' });
  await g.acquire('p');
  g.release('p', 'success');
  const m1 = g.snapshot().find((b) => b.key === 'p/m1')!;
  const m2 = g.snapshot().find((b) => b.key === 'p/m2')!;
  const bare = g.snapshot().find((b) => b.key === 'p')!;
  assert.equal(m1.limit, 3, 'the m1 bucket took the verdict');
  assert.equal(m2.limit, 4, 'the m2 bucket is untouched');
  assert.equal(bare.limit, 4, 'the unbound-provider bucket is untouched');
});

test('#37 layer 2: lastBad records the judged cap — above-watermark fallback and multiply-down both', async () => {
  const g = new AimdGovernor({ maxPerProvider: 8, increaseAfter: 1 });
  const snap = () => g.snapshot().find((s) => s.providerId === 'p')!;

  // multiply-down: lastBad = the old cap
  await g.acquire('p');
  g.release('p', 'throttled');
  assert.equal(snap().limit, 6);
  assert.equal(snap().lastBad, 8, 'multiply-down records the judged cap as lastBad');
  assert.equal(snap().lastGood, undefined);

  // above-watermark fallback: lastBad = the probing cap, watermark kept
  for (let i = 0; i < 6; i++) await g.acquire('p');
  const w = g.acquire('p');
  g.release('p', 'success'); // streak completes → lastGood=6, waiter → 7
  await Promise.resolve();
  assert.equal(snap().limit, 7);
  g.release('p', 'throttled'); // 7 > lastGood=6 → fall back to 6
  assert.equal(snap().limit, 6);
  assert.equal(snap().lastBad, 7, 'the fallback records the probing cap as lastBad');
  await w;
});

test('#37 layer 3: initial vs growthLimit — run bounds raise the ceiling and seed; run exit retunes down', async () => {
  const g = new AimdGovernor({ maxPerProvider: 4 });
  const snap = () => g.snapshot().find((s) => s.providerId === 'p')!;

  g.registerRunBound('p', 'run-1', 12);
  const s1 = snap();
  assert.equal(s1.growthLimit, 12, 'the run bound raises the growth limit');
  assert.equal(s1.initial, 4, 'the starting point stays at D');
  assert.equal(s1.limit, 12, 'a raised bound seeds the cap toward it (nothing throttled recently)');

  // growth is capped at the growthLimit, not at the initial
  for (let i = 0; i < 12; i++) await g.acquire('p');
  for (let i = 0; i < 11; i++) g.release('p', 'success'); // drain to one in-flight, streak grows
  const w = g.acquire('p');
  g.release('p', 'success'); // streak completes with a waiter parked → +1 toward growthLimit
  await Promise.resolve();
  assert.ok(snap().limit > 4, 'growth climbs past the initial when a bound raised the ceiling');

  // the run settles → its bound leaves → the cap is pulled down on the spot
  g.retireRun('run-1');
  const s3 = snap();
  assert.equal(s3.growthLimit, 4, 'growth limit returns to the initial');
  assert.ok(s3.limit <= 4, 'the learned cap never leaks past the lowered ceiling');
  await w;
});

test('#37 layer 3: seeding is refused within the throttle window (no re-charging a fresh wall)', async () => {
  const g = new AimdGovernor({ maxPerProvider: 4 });
  const snap = () => g.snapshot().find((s) => s.providerId === 'p')!;
  await g.acquire('p');
  g.release('p', 'throttled'); // lastThrottledAt = now
  g.registerRunBound('p', 'run-1', 16);
  assert.equal(snap().growthLimit, 16, 'the ceiling still rises');
  assert.equal(snap().limit, 3, 'the CAP does not seed into a wall it just hit');
});

test('#37 layer 4: outcome classes — ended never grows the streak, transient never moves the cap', async () => {
  const g = new AimdGovernor({ maxPerProvider: 8, increaseAfter: 1 });
  const snap = () => g.snapshot().find((s) => s.providerId === 'p')!;

  // an aborted ask (ended): inFlight accounting only
  await g.acquire('p');
  g.release('p', 'ended');
  assert.equal(snap().limit, 8, 'ended does not judge the cap');
  assert.equal(snap().inFlight, 0);

  // a permanent failure (ended) after successes: the streak survives? No —
  // ended is pure accounting; the streak only counts successes, and this ask
  // never completed one.
  await g.acquire('p');
  g.release('p', 'success'); // streak 1 → completes (increaseAfter=1) → lastGood=8, no waiter
  assert.equal(snap().lastGood, 8);

  // transient: clears the streak, keeps the cap
  await g.acquire('p');
  g.release('p', 'success'); // another streak
  await g.acquire('p');
  g.release('p', 'transient');
  assert.equal(snap().limit, 8, 'transient never moves the cap');
  assert.equal(snap().lastGood, 8, 'a proven watermark survives a transient fault');

  // and the regression this layer exists for: the OLD code scored AbortError
  // as success — under the old engine wiring that inflated the streak. The
  // executor now reports ended (asserted at the wiring level below).
});

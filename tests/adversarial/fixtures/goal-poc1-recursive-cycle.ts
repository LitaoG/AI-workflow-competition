/**
 * goal-poc1 variant: a TRUE self-referential type handed to ask<T>.
 *
 * Attack goal: infinite recursion inside the schema synthesizer (stack overflow /
 * hang). Expected defense (src/dwf/schema-synth.ts): the path-scoped seen-set detects
 * the cycle and reports the precise diagnostic 9015 ("recursive type at site ask#N:
 * <typeName>") instead of burning the depth stack.
 *
 * Not compiled by tsconfig; consumed by the CLI "check" command and
 * tests/adversarial/goal-poc1-deep-type.test.ts.
 */
phase('probe');

interface Chain {
  value: number;
  next: Chain;
}

const bomb = agent('cycle-bomb', { provider: 'mock' });
const result = await bomb.ask<Chain>('walk the chain and return the head node');
log(result.value);

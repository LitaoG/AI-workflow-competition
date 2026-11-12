// goal-adv1: classic VM escape — walk `({}).constructor.constructor` to Function and
// compile "return process" from a string inside the sandbox realm.
//
// Defense ① under test: `node bin/workflow.js check` static diagnostics.
// Defense ② under test: vm realm `codeGeneration: { strings: false }`
//   (src/dwf/child-main.ts:288-292) — the realm's own Function must refuse.
//
// This is the DIRECT form: `({}).constructor` is ObjectConstructor, `.constructor` is
// Function, and calling a Function-typed value is TS2349 — expected to be caught by
// the static layer before any sandbox child is spawned.
const F = ({}).constructor.constructor;
const proc = F("return process")();
log("POC1-LEAKED:" + typeof proc);

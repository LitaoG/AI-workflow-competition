// goal-poc3b: CONTROL for goal-poc3. The same toJSON pollution performed on the
// REALM's own Object.prototype (`({}).__proto__` inside the script) must stay
// contained: host-side JSON.stringify runs on the child host realm's Object.prototype
// and must be unaffected — both log frames and the done frame stay clean, the run
// completes. If this control FAILS the same way as poc3, the effect is generic realm
// behavior, not a cross-realm leak.
log("POC3B-pre-realm-pollution");

const probe: any = ({});
probe.__proto__.toJSON = function () {
  return "PWNED-REALM";
};
log("POC3B-post-realm-pollution");
return "POC3B-realm-polluted";

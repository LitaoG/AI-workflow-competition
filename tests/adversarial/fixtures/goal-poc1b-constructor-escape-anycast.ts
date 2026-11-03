// goal-poc1b: goal-poc1 with an `any` cast so the static layer sees nothing
// (Function-typed value becomes any → no TS2349; no banned identifier referenced).
// This variant measures defense ② alone: the vm realm's own Function constructor
// must refuse string compilation (EvalError) when the static layer is bypassed.
const F: any = ({} as any).constructor.constructor;
const proc: any = F("return process")();
log("POC1B-LEAKED:" + typeof proc);

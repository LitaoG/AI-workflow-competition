#!/usr/bin/env bash
# AI-Workflow full offline multi-agent execution showcase, offline (mock, <4s per act).
# Every act prints the evidence line that proves the capability it demos.
# G1: environment preflight (node present); G2: no false-green (set -euo pipefail,
# per-act verdicts, COMPLETE only when all nine evidence lines landed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/workflow.js"
DB="$ROOT/.workflow/demo-dwf.sqlite"
TOUR="$ROOT/demos/capabilities-tour"
mkdir -p "$ROOT/.workflow"
trap 'rm -f "$TOUR/lineage-v2.facade.ts"' EXIT

if ! command -v node >/dev/null 2>&1; then
  echo 'FATAL: node not found — run this in Git Bash on Windows (or install node in your WSL distro).' >&2
  exit 127
fi

ACT_FAILS=0
act_ok() { echo "[act $1] OK  $2"; }
act_fail() { echo "[act $1] FAIL $2" >&2; ACT_FAILS=$((ACT_FAILS + 1)); }

echo "== 1/9 check: incident demo compiles (strict TS + authorization rules) =="
if CHECK_OUT=$(node "$BIN" check demos/incident-triage-remediation/facade.workflow.ts 2>&1); then
  echo "$CHECK_OUT" | head -8
  act_ok 1 "compiled clean: $(echo "$CHECK_OUT" | head -1)"
else
  act_fail 1 "$CHECK_OUT"
fi

echo ""
echo "== 2/9 run: incident triage & remediation (mock) =="
cd "$ROOT/demos/incident-triage-remediation"
OUT=$(node "$BIN" run-script facade.workflow.ts --db "$DB" --args '{"scenario":"p1_db_pool_exhaustion"}')
echo "$OUT" | grep -E "run dwfrun|result:" | head -2
INCIDENT_ID=$(echo "$OUT" | grep -oE 'dwfrun-[A-Za-z0-9_-]+' | tail -1)
if echo "$OUT" | grep -q "completed"; then act_ok 2 "sandbox run completed"; else act_fail 2 "$OUT"; fi

echo ""
echo "== 3/9 resume: the SAME run replays at ZERO provider calls =="
OUT=$(node "$BIN" run-script facade.workflow.ts --db "$DB" --args '{"scenario":"p1_db_pool_exhaustion"}' --resume "$INCIDENT_ID")
echo "$OUT" | grep -E "asks:|⚡" | head -4
if echo "$OUT" | grep -q "asks: 0 (replayed from journal:"; then act_ok 3 "zero-provider replay"; else act_fail 3 "$OUT"; fi

echo ""
echo "== 4/9 run: AWS SDK v2->v3 migration (mock) =="
cd "$ROOT/demos/repo-migration-engine"
MIG_OUT=$(node "$BIN" run-script facade.workflow.ts --db "$DB")
echo "$MIG_OUT" | grep -E "asks:|result:" | head -2
if echo "$MIG_OUT" | grep -q "completed"; then act_ok 4 "migration completed"; else act_fail 4 "$MIG_OUT"; fi

echo ""
echo "== 5/9 amend: edit the script, fork — unchanged ♻ reused, changed ⑂ diverged =="
cd "$TOUR"
sed 's/Assess this reading/SENIOR review with extra scrutiny of this reading/' lineage.facade.ts > lineage-v2.facade.ts
BASE_OUT=$(node "$BIN" run-script lineage.facade.ts --db "$DB")
BASE_ID=$(echo "$BASE_OUT" | grep -oE 'dwfrun-[A-Za-z0-9_-]+' | tail -1)
AMEND_OUT=$(node "$BIN" run-script lineage-v2.facade.ts --db "$DB" --amend "$BASE_ID")
echo "$AMEND_OUT" | grep -E "♻|⑂|asks:" | head -4
if echo "$AMEND_OUT" | grep -q "♻ amended run reused"; then act_ok 5 "amend lineage (reuse + diverge)"; else act_fail 5 "$AMEND_OUT"; fi
rm -f lineage-v2.facade.ts

echo ""
echo "== 6/9 holes: the run parks, fill it with code, it continues as an amend =="
PARK_OUT=$(node "$BIN" run-script growth.facade.ts --db "$DB")
PARK_ID=$(echo "$PARK_OUT" | grep -oE 'dwfrun-[A-Za-z0-9_-]+' | tail -1)
echo "$PARK_OUT" | grep "parked" | head -1
FILL_OUT=$(node "$BIN" fill "$PARK_ID" plan-remediation "$TOUR/fill-plan.js" --db "$DB")
echo "$FILL_OUT" | grep -E "♻|✔ hole" | head -3
if echo "$FILL_OUT" | grep -q "✔ hole"; then act_ok 6 "hole park + fill + amend continue"; else act_fail 6 "$FILL_OUT"; fi

echo ""
echo "== 7/9 escalation: park on a human gate, answer, resume at zero cost =="
GATE_OUT=$(node "$BIN" run-script gate.facade.ts --db "$DB")
GATE_ID=$(echo "$GATE_OUT" | grep -oE 'dwfrun-[A-Za-z0-9_-]+' | tail -1)
QID=$(echo "$GATE_OUT" | grep -oE 'dwfq-[a-z0-9]+' | head -1)
echo "$GATE_OUT" | grep "question" | head -1
ANS_OUT=$(node "$BIN" answer "$GATE_ID" "$QID" "yes - hotfix verified by the deterministic gate" --db "$DB")
echo "$ANS_OUT" | grep -E "⚡|✔ run" | head -3
if echo "$ANS_OUT" | grep -q "completed with the answer"; then act_ok 7 "escalation park + answer resume"; else act_fail 7 "$ANS_OUT"; fi

echo ""
echo "== 8/9 budget: budget.total hard-stops further agent() calls =="
BUD_OUT=$(node "$BIN" run-script budget.facade.ts --db "$DB")
echo "$BUD_OUT" | grep -E "result:" | head -1
if echo "$BUD_OUT" | grep -q "WorkflowBudgetExceededError"; then act_ok 8 "budget hard stop"; else act_fail 8 "$BUD_OUT"; fi

echo ""
echo "== 9/9 view + live attach =="
cd "$ROOT"
if [ -n "$INCIDENT_ID" ] && node "$BIN" view "$INCIDENT_ID" --db "$DB" -o "$ROOT/.workflow/views/demo.html"; then
  act_ok 9 "journal-rendered report + live attach"
  echo "Static report: $ROOT/.workflow/views/demo.html"
  echo "Live attach:   node bin/workflow.js serve $INCIDENT_ID --db $DB"
else
  act_fail 9 "SKIP — no run id or view failed"
fi
echo ""
if [ "$ACT_FAILS" -eq 0 ]; then
  echo "ALL NINE ACTS COMPLETE — every capability evidenced above."
else
  echo "DEMO INCOMPLETE: $ACT_FAILS act(s) failed — see [act N] FAIL lines above." >&2
  exit 1
fi

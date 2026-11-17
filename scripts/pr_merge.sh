#!/usr/bin/env bash
# scripts/pr_merge.sh — the pipe-safe merge entry (Issue #134).
#
# The #105 → #119 → #125 class of process incidents all shared one root cause:
# a merge chain like `gh pr checks N | tail -2 && gh pr merge N` swallows the
# failure exit code inside the pipe, so a red gate or red CI cannot stop the
# merge. This entry runs every stage as a bare command with an explicitly
# checked exit code — nothing is filtered, nothing can be silently swallowed.
#
# Usage:
#   bash scripts/pr_merge.sh <pr_number> [--ack <reason>]
#
# Stages:
#   1. scripts/pr_review_gate.mjs <pr>       (optionally --ack <reason> for the
#                                             §7.1 exemption channel — explicit,
#                                             logged, never implicit)
#   2. gh pr checks <pr>                     (CI must be green — §7.3)
#   3. latest PR comments printed            (the §1.9 human scan, surfaced
#                                             verbatim so it cannot be skipped
#                                             silently; supervisor bracket-form
#                                             markers are gate-checked in stage 1)
#   4. gh pr merge --merge --delete-branch
#   5. git pull --ff-only origin main
set -o pipefail
set -u

PR="${1:-}"
ACK_REASON=""

shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --ack)
      ACK_REASON="${2:-unspecified}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$PR" ]; then
  echo "Usage: bash scripts/pr_merge.sh <pr_number> [--ack <reason>]" >&2
  exit 2
fi

echo "[1/5] pr_review_gate $PR${ACK_REASON:+ (--ack: $ACK_REASON)}"
GATE_ARGS=("$PR")
if [ -n "$ACK_REASON" ]; then
  GATE_ARGS+=("--ack" "$ACK_REASON")
fi
node --experimental-strip-types scripts/pr_review_gate.mjs "${GATE_ARGS[@]}"
GATE_RC=$?
if [ "$GATE_RC" -ne 0 ]; then
  echo "[ABORT] pr_review_gate failed (exit $GATE_RC) — merge forbidden (Issue #134)" >&2
  exit 1
fi

echo "[2/5] gh pr checks $PR"
gh pr checks "$PR"
CHECKS_RC=$?
if [ "$CHECKS_RC" -ne 0 ]; then
  echo "[ABORT] CI checks not green (exit $CHECKS_RC) — merge forbidden (Issue #134)" >&2
  exit 1
fi

echo "[3/5] latest PR comments — human scan for review opinions (supervisor bracket-form markers are gate-checked in stage 1)"
gh pr view "$PR" --comments | tail -60

echo "[4/5] gh pr merge $PR --merge --delete-branch"
gh pr merge "$PR" --merge --delete-branch
MERGE_RC=$?
if [ "$MERGE_RC" -ne 0 ]; then
  echo "[ABORT] merge failed (exit $MERGE_RC)" >&2
  exit 1
fi

echo "[5/5] git pull --ff-only origin main"
git pull --ff-only origin main
PULL_RC=$?
if [ "$PULL_RC" -ne 0 ]; then
  echo "[ABORT] pull failed (exit $PULL_RC) — main may need a manual sync" >&2
  exit 1
fi

echo "✔ pr_merge: PR #$PR merged with gate+CI green verified, main synced (Issue #134 entry)."

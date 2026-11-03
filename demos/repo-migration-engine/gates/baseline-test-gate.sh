#!/usr/bin/env bash
# ============================================================================
# AI-Workflow: Baseline Test Gate (POSIX / Linux / macOS)
# Exit 0 = Baseline Passed, Exit 1 = Test Failure, Exit 2 = Runtime Missing
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "[baseline-test-gate.sh] ERROR: node is not on PATH" >&2
    exit 2
fi

node "${SCRIPT_DIR}/gate-runner.js" baseline "$@"
exit $?

#!/usr/bin/env bash
# ============================================================================
# AI-Workflow: Post-Merge Compilation & Test Gate (POSIX / Linux / macOS)
# Exit 0 = Compilation & Tests Passed, Exit 1 = Diagnostics Failure, Exit 2 = Syntax Error
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "[post-merge-test-gate.sh] ERROR: node is not on PATH" >&2
    exit 2
fi

node "${SCRIPT_DIR}/gate-runner.js" post-merge "$@"
exit $?

#!/usr/bin/env bash
# ============================================================================
# AI-Workflow: Baseline Health Check Gate (POSIX / Linux / macOS)
# Exit 0 = Gate check completed successfully
# Exit 1 = System error
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "[baseline-health-gate.sh] ERROR: node is not installed or not on PATH" >&2
    exit 2
fi

# Execute universal gate runner in baseline mode
node "${SCRIPT_DIR}/gate-runner.js" baseline "$@"
exit $?

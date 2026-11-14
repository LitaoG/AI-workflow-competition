#!/usr/bin/env bash
# ============================================================================
# AI-Workflow: Post-Remediation Verification Gate (POSIX / Linux / macOS)
# Exit 0 = Post-remediation recovery verified (HEALTHY)
# Exit 1 = Recovery failed, service degraded/unhealthy
# Exit 2 = Script configuration error
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "[post-remediation-gate.sh] ERROR: node is not installed or not on PATH" >&2
    exit 2
fi

# Execute universal gate runner in post-remediation verification mode
node "${SCRIPT_DIR}/gate-runner.js" post-remediation "$@"
exit $?

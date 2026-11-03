#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
echo "[KIRO HOOK] Running Pre-Workflow Environment Probe Gate..."
node "$DIR/pre-workflow-gate.js"
echo "[KIRO HOOK] Environment verified successfully."

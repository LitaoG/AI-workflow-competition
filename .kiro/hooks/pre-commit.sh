#!/usr/bin/env bash
set -euo pipefail
echo "[PRE-COMMIT] Validating AI-Workflow invariants before git commit..."
npm run build
npm run test:pbt
npm test
echo "[PRE-COMMIT] 100% of invariants and tests verified. Clean to commit."

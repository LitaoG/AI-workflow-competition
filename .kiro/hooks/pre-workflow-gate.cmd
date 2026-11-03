@echo off
setlocal
echo [KIRO HOOK] Running Pre-Workflow Environment Probe Gate...
node "%~dp0pre-workflow-gate.js"
if %ERRORLEVEL% NEQ 0 (
  echo [GATE FAILED] Deterministic probe failed to verify environment. >&2
  exit /b 1
)
exit /b 0

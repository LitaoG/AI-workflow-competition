@echo off
rem ============================================================================
rem AI-Workflow: Baseline Health Check Gate (Windows CMD)
rem Exit 0 = Gate check completed successfully
rem Exit 1 = System error
rem ============================================================================
setlocal EnableDelayedExpansion

set GATE_DIR=%~dp0
set NODE_EXE=node

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [baseline-health-gate.cmd] ERROR: node.js is not on PATH 1>&2
    exit /b 2
)

rem Execute universal gate runner in baseline mode
"%NODE_EXE%" "%GATE_DIR%gate-runner.js" baseline %*
exit /b %ERRORLEVEL%

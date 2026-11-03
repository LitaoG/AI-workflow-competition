@echo off
rem ============================================================================
rem AI-Workflow: Baseline Test Gate (Windows CMD)
rem Exit 0 = Baseline Passed, Exit 1 = Test Failure, Exit 2 = Runtime Missing
rem ============================================================================
setlocal EnableDelayedExpansion

set GATE_DIR=%~dp0
set NODE_EXE=node

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [baseline-test-gate.cmd] ERROR: node is not on PATH 1>&2
    exit /b 2
)

rem Invoke universal gate runner in baseline mode
"%NODE_EXE%" "%GATE_DIR%gate-runner.js" baseline %*
exit /b %ERRORLEVEL%

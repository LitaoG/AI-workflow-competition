@echo off
rem ============================================================================
rem AI-Workflow: Post-Merge Compilation & Test Gate (Windows CMD)
rem Exit 0 = Compilation & Tests Passed, Exit 1 = Diagnostics Failure, Exit 2 = Syntax Error
rem ============================================================================
setlocal EnableDelayedExpansion

set GATE_DIR=%~dp0
set NODE_EXE=node

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [post-merge-test-gate.cmd] ERROR: node is not on PATH 1>&2
    exit /b 2
)

"%NODE_EXE%" "%GATE_DIR%gate-runner.js" post-merge %*
exit /b %ERRORLEVEL%

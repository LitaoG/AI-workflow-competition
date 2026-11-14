@echo off
rem ============================================================================
rem AI-Workflow: Post-Remediation Verification Gate (Windows CMD)
rem Exit 0 = Post-remediation recovery verified (HEALTHY)
rem Exit 1 = Recovery failed, service degraded/unhealthy
rem Exit 2 = Script configuration error
rem ============================================================================
setlocal EnableDelayedExpansion

set GATE_DIR=%~dp0
set NODE_EXE=node

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [post-remediation-gate.cmd] ERROR: node.js is not on PATH 1>&2
    exit /b 2
)

rem Execute universal gate runner in post-remediation verification mode
"%NODE_EXE%" "%GATE_DIR%gate-runner.js" post-remediation %*
exit /b %ERRORLEVEL%

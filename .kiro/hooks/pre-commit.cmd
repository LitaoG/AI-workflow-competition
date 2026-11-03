@echo off
setlocal
echo [PRE-COMMIT] Validating AI-Workflow invariants before git commit...
call npm.cmd run build
if %ERRORLEVEL% NEQ 0 exit /b 1
call npm.cmd run test:pbt
if %ERRORLEVEL% NEQ 0 exit /b 1
call npm.cmd test
if %ERRORLEVEL% NEQ 0 exit /b 1
echo [PRE-COMMIT] 100% of invariants and tests verified. Clean to commit.
exit /b 0

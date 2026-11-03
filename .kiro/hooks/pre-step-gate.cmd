@echo off
setlocal
node "%~dp0pre-step-gate.js" %*
exit /b %ERRORLEVEL%

@echo off
setlocal
node "%~dp0post-step-audit.js" %*
exit /b %ERRORLEVEL%

@echo off
setlocal
title CoreScope status
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\corescope-runtime.ps1" -Action Status
set "CORESCOPE_EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %CORESCOPE_EXIT_CODE%

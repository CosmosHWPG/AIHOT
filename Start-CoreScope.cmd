@echo off
setlocal
title CoreScope startup
cd /d "%~dp0"
echo Starting CoreScope. The website is ready only after the final READY message.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\corescope-runtime.ps1" -Action Start
set "CORESCOPE_EXIT_CODE=%ERRORLEVEL%"
if not "%CORESCOPE_EXIT_CODE%"=="0" (
  echo.
  echo CoreScope failed to start. The failure step, time and reason are recorded in:
  echo "%~dp0.data\logs\startup.error.log"
  echo Keep this window or review the log above before retrying.
  pause
  exit /b %CORESCOPE_EXIT_CODE%
)

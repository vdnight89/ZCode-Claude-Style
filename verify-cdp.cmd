@echo off
rem ZCode CDP channel verification - launcher for verify-cdp.ps1
rem   verify-cdp.cmd             full run: quit ZCode, relaunch it with --remote-debugging-port, verify
rem   verify-cdp.cmd -CheckOnly  read-only check of the ZCode that is running right now
rem   verify-cdp.cmd -Force      force-kill ZCode instead of waiting for a manual quit
setlocal
set "SCRIPT=%~dp0verify-cdp.ps1"
if not exist "%SCRIPT%" (
  echo verify-cdp.ps1 not found next to this launcher.
  pause
  exit /b 3
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%

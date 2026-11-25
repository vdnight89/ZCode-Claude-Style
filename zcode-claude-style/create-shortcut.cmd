@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" -CreateShortcut
set "ZC_LAUNCH_EXIT=%errorlevel%"
if not "%ZC_LAUNCH_EXIT%"=="0" pause
exit /b %ZC_LAUNCH_EXIT%

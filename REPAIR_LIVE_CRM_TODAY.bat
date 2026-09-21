@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\check_live_crm_today.ps1" -Repair
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

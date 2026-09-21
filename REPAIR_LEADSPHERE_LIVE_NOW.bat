@echo off
setlocal
cd /d "%~dp0"
echo ====================================================
echo    NUNES AI CRM - REPAIR LEADSPHERE LIVE NOW
echo ====================================================
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repair_leadsphere_live_now.ps1"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo [PASS] Live CRM connection recovery finished.
) else (
  echo [CHECK REQUIRED] Recovery stopped with code %RC%.
  echo Read the ROOT CAUSE message above.
)
pause
exit /b %RC%

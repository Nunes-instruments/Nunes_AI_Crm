@echo off
setlocal
cd /d "%~dp0"
echo ====================================================
echo          NUNES AI CRM - OWNER PC SETUP
echo ====================================================
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_owner_pc.ps1"
if errorlevel 1 (
  echo.
  echo OWNER PC SETUP COULD NOT FINISH.
  pause
  exit /b 1
)
exit /b 0

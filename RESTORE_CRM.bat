@echo off
setlocal
cd /d "%~dp0"
title NUNES AI CRM - Restore
echo ====================================================
echo             NUNES AI CRM - RESTORE
echo ====================================================
echo.
echo The CRM should be stopped before restoring data.
if exist "%~dp0data\crm.pid" (
  choice /C YN /N /M "CRM appears to be running. Stop it now? [Y/N]: "
  if errorlevel 2 exit /b 0
  call "%~dp0STOP_CRM.bat" /silent
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restore.ps1"
echo.
pause
endlocal

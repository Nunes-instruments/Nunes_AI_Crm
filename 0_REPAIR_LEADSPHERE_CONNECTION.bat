@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - Repair LeadSphere Connection
cls
echo ====================================================
echo       REPAIR LEADSPHERE CONNECTION - v1.2.2
echo ====================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repair_leadsphere_connection.ps1"
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
  echo Repair completed. The default API key is now encrypted for this Windows user.
  echo Close the old CRM window and run START_CRM.bat.
) else (
  echo Automatic repair failed.
  echo Run CONFIGURE_COMPANY_CRM.bat to keep defaults or change the connection manually.
)
echo.
pause
exit /b %RC%

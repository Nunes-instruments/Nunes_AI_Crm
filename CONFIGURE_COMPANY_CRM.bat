@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - LeadSphere Settings
cls
echo ====================================================
echo          LEADSPHERE CONNECTION SETTINGS
echo ====================================================
echo.
echo Default LeadSphere settings and API key are built in.
echo Press ENTER in the setup to keep all defaults.
echo Type C only when you want to change connection values.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure_company_crm.ps1"
if errorlevel 1 goto :fail
echo.
echo LeadSphere connection saved.
echo Restart NUNES AI CRM to apply it.
echo.
pause
exit /b 0
:fail
echo.
echo Setup was not completed. Check the details above and try again.
echo.
pause
exit /b 1

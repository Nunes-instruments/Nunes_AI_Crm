@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - Repair Desktop Icon
cls
echo ====================================================
echo          NUNES AI CRM - DESKTOP ICON REPAIR
echo ====================================================
echo.
echo CRM data and settings will NOT be changed.
echo Creating / repairing the desktop icon only...
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repair_desktop_icon.ps1"
if errorlevel 1 goto :fail
echo.
echo SUCCESS: NUNES AI CRM desktop icon is ready.
echo If the old blank icon is still cached, click the Desktop and press F5 once.
echo.
pause
exit /b 0
:fail
echo.
echo Desktop icon repair could not finish.
echo.
pause
exit /b 1

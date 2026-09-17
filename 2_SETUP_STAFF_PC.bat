@echo off
setlocal EnableExtensions
title NUNES AI CRM - Fast Staff PC Setup
cls
pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo Could not open the NUNES AI CRM setup folder.
  echo Copy or extract the setup folder locally and try again.
  pause
  exit /b 1
)
set "NUNES_SETUP_ROOT=%CD%"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%NUNES_SETUP_ROOT%\scripts\setup_staff_pc.ps1"
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo.
  echo STAFF PC SETUP COULD NOT FINISH.
  pause
  exit /b %RC%
)
timeout /t 1 /nobreak >nul
exit /b 0

@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM

rem V2.9.1: open_crm_app.ps1 derives the CRM root from its own location.
rem Do not pass %%~dp0 as a quoted trailing-backslash argument; on some Windows
rem builds that can arrive in PowerShell with a literal quote and break Test-Path.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open_crm_app.ps1"
if errorlevel 1 (
  echo.
  echo NUNES AI CRM could not open.
  echo Check: %~dp0logs\server-console.log
  echo.
  pause
  exit /b 1
)
exit /b 0

@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - Owner Setup Code
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\show_owner_setup_code.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo OWNER SETUP CODE COULD NOT BE PREPARED.
  echo The repair script has already tried to restart the latest local CRM server.
  echo Check: %%LOCALAPPDATA%%\NunesAI\CRMServer\App\logs\server-console.log
  echo.
)
pause
exit /b %RC%

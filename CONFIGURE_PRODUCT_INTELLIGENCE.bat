@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - Product Intelligence Setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure_gemini.ps1"
echo.
pause
endlocal

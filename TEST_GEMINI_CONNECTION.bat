@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - Test Gemini Connection
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure_gemini.ps1" -TestOnly
echo.
pause
endlocal

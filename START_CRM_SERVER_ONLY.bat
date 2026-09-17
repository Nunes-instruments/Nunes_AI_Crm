@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>&1
set CRM_NO_BROWSER=1
call "%~dp0START_CRM.bat" /background >> "%~dp0logs\server-console.log" 2>&1
exit /b %errorlevel%

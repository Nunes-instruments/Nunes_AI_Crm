@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - Stop Server
set "LOCAL_APP=%LOCALAPPDATA%\NunesAI\CRMServer\App"
if /I not "%~dp0"=="%LOCAL_APP%\" (
  if exist "%LOCAL_APP%\STOP_CRM.bat" (
    call "%LOCAL_APP%\STOP_CRM.bat" %*
    exit /b %errorlevel%
  )
)
set SILENT=0
if /I "%~1"=="/silent" set SILENT=1
if not exist "%~dp0data\crm.pid" (
  echo NUNES AI CRM does not appear to be running.
  if exist "%~dp0data\active_port.txt" del /q "%~dp0data\active_port.txt" >nul 2>&1
  if "%SILENT%"=="0" pause
  exit /b 0
)
set /p CRM_PID=<"%~dp0data\crm.pid"
echo Stopping NUNES AI CRM process %CRM_PID%...
taskkill /PID %CRM_PID% /T /F >nul 2>&1
if exist "%~dp0data\crm.pid" del /q "%~dp0data\crm.pid" >nul 2>&1
if exist "%~dp0data\active_port.txt" del /q "%~dp0data\active_port.txt" >nul 2>&1
echo CRM stopped.
timeout /t 1 >nul
if "%SILENT%"=="0" pause
endlocal

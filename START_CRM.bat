@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM Server

set "LOCAL_APP=%LOCALAPPDATA%\NunesAI\CRMServer\App"
rem Never run the live server directly from a ZIP/NAS/network/source folder.
if /I not "%~dp0"=="%LOCAL_APP%\" (
  echo NUNES AI CRM is moving the server to the safe local Windows location...
  call "%~dp0INSTALL_CRM.bat"
  exit /b %errorlevel%
)

if /I not "%~1"=="/background" cls
if /I not "%~1"=="/background" echo ====================================================
if /I not "%~1"=="/background" echo                 NUNES AI CRM
if /I not "%~1"=="/background" echo ====================================================
if /I not "%~1"=="/background" echo Starting main CRM server...
if /I not "%~1"=="/background" echo.

if not exist "%~dp0data" mkdir "%~dp0data" >nul 2>&1
if not exist "%~dp0backups" mkdir "%~dp0backups" >nul 2>&1
if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>&1

set "USER_MARKER=%~dp0data\.crm_user_%USERDOMAIN%_%USERNAME%.ready"
if not exist "%USER_MARKER%" (
  powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\initialize_leadsphere_defaults.ps1" -Quiet >nul 2>&1
  if not errorlevel 1 >"%USER_MARKER%" echo ready
)

if not exist "%~dp0data\node_path.txt" goto :prepare_runtime
set /p NODE_EXE=<"%~dp0data\node_path.txt"
if not exist "%NODE_EXE%" goto :prepare_runtime
goto :run

:prepare_runtime
if /I not "%~1"=="/background" echo First use on this Windows PC - preparing the portable runtime once...
powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\ensure_node.ps1" -Quiet >nul
if errorlevel 1 goto :fail
set /p NODE_EXE=<"%~dp0data\node_path.txt"
if not exist "%NODE_EXE%" goto :fail

:run
set NODE_NO_WARNINGS=1
"%NODE_EXE%" "%~dp0server.mjs"
if errorlevel 1 goto :serverfail
endlocal
exit /b 0

:fail
if /I "%~1"=="/background" exit /b 1
echo.
echo ERROR STARTING NUNES AI CRM
echo The portable runtime could not be prepared.
echo Run INSTALL_CRM.bat once while connected to the internet.
echo.
pause
exit /b 1

:serverfail
if /I "%~1"=="/background" exit /b 1
echo.
echo ERROR STARTING NUNES AI CRM
echo The CRM server stopped unexpectedly.
echo Check logs\server-console.log for details.
echo.
pause
exit /b 1

@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - One Time Setup
cls
set "LOCAL_APP=%LOCALAPPDATA%\NunesAI\CRMServer\App"

rem Always install the MAIN server on the local Windows disk.
rem This is required because live SQLite WAL databases are not safe on NAS/SMB shares.
if /I not "%~dp0"=="%LOCAL_APP%\" (
  echo ====================================================
  echo          NUNES AI CRM - ONE TIME SETUP
  echo ====================================================
  echo.
  echo Installing the MAIN CRM server on this computer...
  echo Your source ZIP/folder may stay on NAS or another drive.
  echo.
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_local_server.ps1"
  if errorlevel 1 goto :fail
  call "%LOCAL_APP%\INSTALL_CRM.bat" /local
  exit /b %errorlevel%
)

if not exist "%~dp0data" mkdir "%~dp0data" >nul 2>&1
if not exist "%~dp0backups" mkdir "%~dp0backups" >nul 2>&1
if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>&1

echo ====================================================
echo          NUNES AI CRM - LOCAL SERVER SETUP
echo ====================================================
echo.
echo No npm install. No development tools.
echo The live database stays on this MAIN CRM computer.
echo Staff computers use desktop client shortcuts only.
echo.

powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\ensure_node.ps1"
if errorlevel 1 goto :fail

powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\initialize_leadsphere_defaults.ps1" -Quiet >nul 2>&1
set "USER_MARKER=%~dp0data\.crm_user_%USERDOMAIN%_%USERNAME%.ready"
>"%USER_MARKER%" echo ready

powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_local_server.ps1" -Quiet >nul

echo.
echo Setup complete.
echo 1. Main server runs from: %~dp0
echo 2. Desktop app: NUNES AI CRM - SERVER
echo 3. Server auto-starts when this Windows user signs in.
echo 4. Run SETUP_FIREWALL.bat once as Administrator for office staff PCs.
echo 5. On the OWNER PC run SETUP_OWNER_PC.bat once.
echo 6. On each of the 10 staff PCs run 2_SETUP_STAFF_PC.bat once.
echo 7. Run SHOW_OWNER_SETUP_CODE.bat on this server when setting up the owner PC.
echo.
rem V2.10.0: restart after a safe incremental update so all clients receive the new server/UI immediately.
rem Restart it once so the new role/security routes and owner setup code are active now.
call "%~dp0STOP_CRM.bat" /silent >nul 2>&1
timeout /t 1 /nobreak >nul
call "%~dp0OPEN_NUNES_CRM.bat"
exit /b %errorlevel%

:fail
echo.
echo SETUP COULD NOT FINISH.
echo Check the message above. Internet is required only once if this PC has no compatible Node runtime.
echo.
pause
exit /b 1

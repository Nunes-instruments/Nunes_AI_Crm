@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - Check
cls
echo ====================================================
echo             NUNES AI CRM - SYSTEM CHECK
echo ====================================================
echo.
echo Windows architecture: %PROCESSOR_ARCHITECTURE%
if defined PROCESSOR_ARCHITEW6432 echo Native architecture : %PROCESSOR_ARCHITEW6432%
if exist "%~dp0data\node_path.txt" (
  set /p NODE_EXE=<"%~dp0data\node_path.txt"
  if exist "%NODE_EXE%" (echo Runtime: READY) else (echo Runtime: PATH MISSING)
) else (echo Runtime: WILL AUTO-PREPARE ON FIRST START)
if exist "%~dp0data\nunes-crm.sqlite" (echo Database: READY) else (echo Database: Will be created on first start)
if exist "%~dp0data\company-crm.json" (
  if exist "%~dp0data\company-crm-key.txt" (echo Company CRM: CONNECTION FILES READY) else (echo Company CRM: KEY INITIALIZATION REQUIRED)
) else (echo Company CRM: INITIALIZATION REQUIRED)
if exist "%~dp0data\active_port.txt" (
  set /p CRM_PORT=<"%~dp0data\active_port.txt"
  echo Last active port: %CRM_PORT%
  powershell -NoLogo -NoProfile -NonInteractive -Command "try {$r=Invoke-RestMethod -Uri 'http://127.0.0.1:%CRM_PORT%/api/health' -TimeoutSec 2; if($r.ok){Write-Host 'Server: RUNNING' -ForegroundColor Green}else{Write-Host 'Server: NOT RESPONDING' -ForegroundColor Yellow}} catch {Write-Host 'Server: NOT RESPONDING' -ForegroundColor Yellow}"
) else (echo Server: NOT RUNNING)
echo.
echo Project folder: %~dp0
echo.
pause
endlocal

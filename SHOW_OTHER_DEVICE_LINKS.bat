@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - Staff Connection Address
cls
set "LOCAL_APP=%LOCALAPPDATA%\NunesAI\CRMServer\App"
if /I not "%~dp0"=="%LOCAL_APP%\" (
  if exist "%LOCAL_APP%\SHOW_OTHER_DEVICE_LINKS.bat" (
    call "%LOCAL_APP%\SHOW_OTHER_DEVICE_LINKS.bat"
    exit /b %errorlevel%
  )
)
echo ====================================================
echo        NUNES AI CRM - STAFF CONNECTION ADDRESS
echo ====================================================
echo.
if not exist "%~dp0data\active_port.txt" (
  echo Start the CRM first from the NUNES AI CRM desktop app.
  echo.
  pause
  exit /b 1
)
set /p CRM_PORT=<"%~dp0data\active_port.txt"
echo RECOMMENDED OFFICE NAME:
echo   http://%COMPUTERNAME%:%CRM_PORT%
echo.
echo LOCAL MAIN SERVER PC:
echo   http://127.0.0.1:%CRM_PORT%
echo.
echo OFFICE NETWORK ADDRESSES:
powershell -NoLogo -NoProfile -NonInteractive -Command "$p='%CRM_PORT%'; Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue ^| Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'Loopback'} ^| Select-Object -ExpandProperty IPAddress -Unique ^| ForEach-Object {Write-Host ('  http://' + $_ + ':' + $p) -ForegroundColor Cyan}"
echo.
where tailscale >nul 2>&1
if not errorlevel 1 (
  for /f "usebackq delims=" %%I in (`tailscale ip -4 2^>nul`) do echo TAILSCALE: http://%%I:%CRM_PORT%
)
echo.
echo Use ONE reachable address when SETUP_STAFF_PC.bat asks for the MAIN CRM server address.
echo Run SETUP_FIREWALL.bat once as Administrator on this MAIN server PC if staff cannot connect.
echo.
pause
endlocal

@echo off
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Administrator permission is required one time for LAN/Tailscale firewall access.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
title NUNES AI CRM - Firewall Setup
echo Configuring Windows Firewall for NUNES AI CRM...
netsh advfirewall firewall delete rule name="NUNES AI CRM LAN" >nul 2>&1
netsh advfirewall firewall delete rule name="NUNES AI CRM Tailscale" >nul 2>&1
netsh advfirewall firewall add rule name="NUNES AI CRM LAN" dir=in action=allow protocol=TCP localport=8765-8775 profile=private >nul
if errorlevel 1 goto :fail
rem Tailscale IPv4 addresses use 100.64.0.0/10. Allow only that range on any Windows network profile.
netsh advfirewall firewall add rule name="NUNES AI CRM Tailscale" dir=in action=allow protocol=TCP localport=8765 remoteip=100.64.0.0/10 profile=any >nul
if errorlevel 1 goto :fail
echo Firewall rules added successfully.
echo LAN: ports 8765-8775 on Private profile.
echo Tailscale: port 8765 only from 100.64.0.0/10.
pause
endlocal
exit /b 0
:fail
echo Firewall configuration failed.
pause
exit /b 1

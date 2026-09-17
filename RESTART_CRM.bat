@echo off
cd /d "%~dp0"
call "%~dp0STOP_CRM.bat" /silent
echo Restarting...
timeout /t 1 >nul
call "%~dp0START_CRM.bat"

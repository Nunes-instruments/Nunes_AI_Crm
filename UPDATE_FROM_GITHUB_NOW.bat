@echo off
setlocal
set "APP=%LOCALAPPDATA%\NunesAI\CRMServer\App"
if not exist "%APP%\scripts\update_from_github.ps1" (
  echo NUNES AI CRM V2.11.1 or newer is not installed on this main server yet.
  echo Run UPDATE_REPAIR_SERVER.bat from the V2.11.1 package once first.
  pause
  exit /b 1
)
echo ====================================================
echo       NUNES AI CRM - GITHUB UPDATE NOW
echo ====================================================
echo.
echo Source: Nunes-instruments/Nunes_AI_Crm / main
 echo Existing database and local settings will be preserved.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%APP%\scripts\update_from_github.ps1" -Repo "Nunes-instruments/Nunes_AI_Crm" -Branch "main" -InstallRoot "%APP%" -Force
if errorlevel 1 (
  echo.
  echo GitHub update failed. Your existing database was not intentionally replaced.
  echo Check: %APP%\logs\github-updater.log
  pause
  exit /b 1
)
echo.
echo Update check finished.
echo Owner and Staff screens will reload automatically when the server version changes.
pause
endlocal

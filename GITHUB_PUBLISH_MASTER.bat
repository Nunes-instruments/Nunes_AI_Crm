@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - PUBLISH MASTER TO GITHUB
cls
echo ====================================================
echo       NUNES AI CRM - GITHUB MASTER PUBLISH
echo ====================================================
echo.
echo Repository: Nunes-instruments/Nunes_AI_Crm
echo Branch:     main
echo.
echo This tool publishes SOURCE CODE only.
echo Live database, .env, OAuth/device tokens, backups, logs,
echo runtime files and staff photos are excluded.
echo.
echo [1] PUSH TO GITHUB NOW using Git (recommended)
echo [2] CREATE SAFE DESKTOP UPLOAD FOLDER for manual GitHub upload
echo [3] EXIT
echo.
choice /C 123 /N /M "Select 1, 2 or 3: "
if errorlevel 3 exit /b 0
if errorlevel 2 goto MANUAL

:PUSH
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish_to_github.ps1" -Mode Push
if errorlevel 1 (
  echo.
  echo GITHUB PUSH DID NOT COMPLETE.
  echo No live CRM data was intentionally changed.
  echo You can run this BAT again and choose option 2 for manual browser upload.
  pause
  exit /b 1
)
echo.
echo GitHub main is updated successfully.
echo Synchronizing the installed MAIN SERVER from GitHub now...
set "APP=%LOCALAPPDATA%\NunesAI\CRMServer\App"
if exist "%APP%\scripts\update_from_github.ps1" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%APP%\scripts\update_from_github.ps1" -Repo "Nunes-instruments/Nunes_AI_Crm" -Branch "main" -InstallRoot "%APP%" -Force
  if errorlevel 1 (
    echo.
    echo GitHub push succeeded, but immediate server sync did not finish.
    echo Run UPDATE_FROM_GITHUB_NOW.bat once after checking the server internet connection.
    pause
    exit /b 1
  )
  echo.
  echo MAIN SERVER synchronized and restarted from GitHub.
  echo Owner and Staff CRM screens will receive the server version automatically.
) else (
  echo.
  echo GitHub push succeeded. V2.11.1 is not installed in the standard server path yet.
  echo Run UPDATE_REPAIR_SERVER.bat once on the MAIN SERVER.
)
pause
exit /b 0

:MANUAL
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish_to_github.ps1" -Mode Folder
if errorlevel 1 (
  echo.
  echo Could not create the safe upload folder.
  pause
  exit /b 1
)
echo.
echo Safe GitHub upload folder is ready on the Desktop.
echo Upload the CONTENTS of that folder to the root of GitHub main.
pause
exit /b 0

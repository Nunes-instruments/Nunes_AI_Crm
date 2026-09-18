@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - GITHUB RELEASE
cls
echo ====================================================
echo          NUNES AI CRM - GITHUB RELEASE
echo ====================================================
echo.
echo Repository: Nunes-instruments/Nunes_AI_Crm
echo Production: main
echo Test:       testing
echo.
echo [1] TEST IN BRANCH + RELEASE TO MAIN   ^(recommended^)
echo [2] DIRECT PUSH TO MAIN                 ^(emergency only^)
echo [3] CREATE SAFE MANUAL UPLOAD FOLDER
echo [4] EXIT
echo.
echo Option 1 protects production: code is pushed to testing, cloned back,
echo syntax/smoke-tested, validated by GitHub Actions, then the exact tested
echo commit is fast-forwarded to main. MAIN SERVER then updates Owner + Staff.
echo.
choice /C 1234 /N /M "Select 1, 2, 3 or 4: "
if errorlevel 4 exit /b 0
if errorlevel 3 goto MANUAL
if errorlevel 2 goto DIRECT

:TESTRELEASE
call "%~dp0GITHUB_TEST_AND_RELEASE.bat"
exit /b %ERRORLEVEL%

:DIRECT
echo.
echo WARNING: This bypasses the testing branch release gate.
choice /C YN /N /M "Directly push current source to production main? [Y/N]: "
if errorlevel 2 exit /b 0
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish_to_github.ps1" -Mode Push -Branch main
if errorlevel 1 (
  echo.
  echo DIRECT GITHUB PUSH DID NOT COMPLETE.
  echo No live CRM data was intentionally changed.
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
    echo GitHub push succeeded, but immediate server sync did not finish.
    echo Run UPDATE_FROM_GITHUB_NOW.bat on the MAIN SERVER.
    pause
    exit /b 1
  )
  echo MAIN SERVER synchronized and restarted from GitHub.
  echo Owner and Staff CRM screens will receive the server version automatically.
) else (
  echo GitHub push succeeded. This PC does not have the installed MAIN SERVER.
  echo The actual server will update on its next automatic GitHub check.
)
pause
exit /b 0

:MANUAL
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish_to_github.ps1" -Mode Folder -Branch main
if errorlevel 1 (
  echo Could not create the safe upload folder.
  pause
  exit /b 1
)
echo.
echo Safe GitHub upload folder is ready on the Desktop.
pause
exit /b 0

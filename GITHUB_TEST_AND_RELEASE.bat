@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - TEST BRANCH RELEASE
cls
echo ====================================================
echo      NUNES AI CRM - TEST BRANCH RELEASE GATE
echo ====================================================
echo.
echo Repository: Nunes-instruments/Nunes_AI_Crm
echo Test:       testing
echo Production: main
echo.
echo Recommended process:
echo Current code -^> testing branch -^> isolated test -^> GitHub Actions
echo -^> exact tested commit to main -^> MAIN SERVER -^> Owner + Staff.
echo.
echo Live database, .env, OAuth/device tokens, backups, logs and
echo staff photos are NOT uploaded and are NOT used by the test server.
echo.
echo [1] TEST + RELEASE TO MAIN   ^(recommended^)
echo [2] TEST ONLY                ^(do not change main^)
echo [3] EXIT
echo.
choice /C 123 /N /M "Select 1, 2 or 3: "
if errorlevel 3 exit /b 0
if errorlevel 2 goto TESTONLY

:RELEASE
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\github_test_release.ps1" -Mode TestAndRelease
if errorlevel 1 (
  echo.
  echo TEST/RELEASE DID NOT COMPLETE. Production main was protected by the release gate.
  pause
  exit /b 1
)
echo.
echo Tested code is now on production main.
echo MAIN SERVER sync was triggered when this was run on the server PC.
echo Owner and Staff will receive the new server version automatically.
pause
exit /b 0

:TESTONLY
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\github_test_release.ps1" -Mode TestOnly
if errorlevel 1 (
  echo.
  echo TEST FAILED. Production main was not changed.
  pause
  exit /b 1
)
echo.
echo TEST PASSED. Production main was not changed.
pause
exit /b 0

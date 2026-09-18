@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - UPDATE / REPAIR
cls
echo ====================================================
echo          NUNES AI CRM V2.11.11
echo          UPDATE / REPAIR / RELEASE
echo ====================================================
echo.
set "APP=%LOCALAPPDATA%\NunesAI\CRMServer\App"
if exist "%APP%\scripts\update_from_github.ps1" goto INSTALLED

echo This PC does not yet have the GitHub-enabled MAIN SERVER installation.
echo The first install is data-safe and keeps any existing local CRM data it finds.
echo.
choice /C YN /N /M "Install/repair this MAIN SERVER now? [Y/N]: "
if errorlevel 2 exit /b 0
goto REPAIR

:INSTALLED
echo GitHub-enabled MAIN SERVER detected.
echo.
echo Recommended future process:
echo   current code -^> testing branch -^> isolated tests -^> GitHub Actions
echo   -^> exact tested commit to main -^> MAIN SERVER -^> Owner + Staff.
echo.
echo [1] TEST + RELEASE THIS CODE THROUGH GITHUB   ^(recommended^)
echo [2] LOCAL REPAIR/INSTALL THIS PACKAGE          ^(recovery only^)
echo [3] EXIT
echo.
choice /C 123 /N /M "Select 1, 2 or 3: "
if errorlevel 3 exit /b 0
if errorlevel 2 goto REPAIR
call "%~dp0GITHUB_TEST_AND_RELEASE.bat"
exit /b %ERRORLEVEL%

:REPAIR
echo.
echo LOCAL DATA-SAFE REPAIR
 echo Existing SQLite data, leads, quotations, reports, staff history,
echo OAuth/Gemini/LeadSphere settings, backups and device links are preserved.
echo.
call "%~dp0INSTALL_CRM.bat"
if errorlevel 1 (
  echo.
  echo REPAIR DID NOT FINISH. Existing data was not intentionally replaced.
  pause
  exit /b 1
)
echo.
echo V2.11.11 local repair/install finished.
echo MAIN SERVER keeps checking GitHub production main automatically.
echo Owner and Staff web apps reload when the server version changes.
echo.
echo For normal future feature/bug releases, use GITHUB_TEST_AND_RELEASE.bat.
pause
endlocal

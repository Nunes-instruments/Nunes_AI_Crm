@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - SAFE UPDATE / REPAIR
cls
echo ====================================================
echo       NUNES AI CRM - SAFE UPDATE / REPAIR
echo ====================================================
echo.
echo V2.11.3 FIRST-TIME GITHUB UPDATE ENABLEMENT
echo.
echo This safely installs this package on the MAIN SERVER once.
echo Existing SQLite data, leads, quotations, reports, staff history,
echo OAuth/Gemini/LeadSphere settings, backups and device links are preserved.
echo.
call "%~dp0INSTALL_CRM.bat"
if errorlevel 1 (
  echo.
  echo UPDATE DID NOT FINISH. Existing data was not intentionally replaced.
  pause
  exit /b 1
)
echo.
echo V2.11.3 installed.
echo From now on the MAIN SERVER checks GitHub automatically every 5 minutes.
echo Future code pushed to GitHub main is downloaded safely by the server.
echo Owner and Staff web apps reload automatically after the server version changes.
echo Desktop launchers self-update from the main server when opened.
echo.
echo If GitHub main is still empty, you can publish this SAME master code now.
echo The publish tool excludes live database/credentials and provides both
echo automatic Git push and manual browser-upload options.
echo.
choice /C YN /N /M "Publish V2.11.3 to GitHub main now? [Y/N]: "
if errorlevel 2 goto DONE
call "%~dp0GITHUB_PUBLISH_MASTER.bat"
:DONE
echo.
pause
endlocal

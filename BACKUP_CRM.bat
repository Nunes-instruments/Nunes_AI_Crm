@echo off
setlocal
cd /d "%~dp0"
title NUNES AI CRM - Backup
if not exist "%~dp0data\node_path.txt" (
  echo Runtime not installed. Run INSTALL_CRM.bat first.
  pause
  exit /b 1
)
set /p NODE_EXE=<"%~dp0data\node_path.txt"
set NODE_NO_WARNINGS=1
set TMP_BACKUP_RESULT=%TEMP%\nunes_crm_backup_result_%RANDOM%.txt
"%NODE_EXE%" "%~dp0scripts\backup.mjs" > "%TMP_BACKUP_RESULT%"
if errorlevel 1 (
  type "%TMP_BACKUP_RESULT%"
  del /q "%TMP_BACKUP_RESULT%" >nul 2>&1
  echo Backup failed.
  pause
  exit /b 1
)
set /p BACKUP_PATH=<"%TMP_BACKUP_RESULT%"
del /q "%TMP_BACKUP_RESULT%" >nul 2>&1
echo.
echo Backup completed successfully:
echo %BACKUP_PATH%
echo.
pause
endlocal

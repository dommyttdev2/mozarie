@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"

if not exist "%PYTHON%" set "PYTHON=python"
"%PYTHON%" "%APP_DIR%server.py"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo Mozarie stopped with exit code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%

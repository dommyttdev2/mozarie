@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"

if exist "%APP_DIR%.venv\Scripts\python.exe" goto :install
py -3.11 -m venv "%APP_DIR%.venv" >nul 2>nul
if errorlevel 1 python -m venv "%APP_DIR%.venv"
if errorlevel 1 (
  echo [Mozarie] Python 3.11 or newer is required to create .venv.
  pause
  exit /b 1
)

:install
"%APP_DIR%.venv\Scripts\python.exe" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 goto :python_too_old
"%APP_DIR%.venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :failed
"%APP_DIR%.venv\Scripts\python.exe" -m pip install -r "%APP_DIR%requirements.txt"
if errorlevel 1 goto :failed
echo [Mozarie] Setup complete. Run run.bat.
pause
exit /b 0

:failed
echo [Mozarie] Setup failed. .venv was left in place for inspection.
pause
exit /b 1

:python_too_old
echo [Mozarie] Python 3.11 or newer is required. Remove .venv and run setup.bat with Python 3.11 or newer.
pause
exit /b 1

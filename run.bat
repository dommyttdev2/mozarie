@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
if defined MOZARIE_PYTHON (set "PYTHON=%MOZARIE_PYTHON%") else set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"
if not exist "%PYTHON%" goto :missing_python
call :validate_python
if errorlevel 1 goto :missing_python

"%PYTHON%" "%APP_DIR%server.py"
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" exit /b 0
echo Mozarie stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

:missing_python
echo [Mozarie] Python 3.11 or newer was not found. Run setup.bat, or set MOZARIE_PYTHON.
pause
exit /b 1

:validate_python
"%PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
exit /b %ERRORLEVEL%

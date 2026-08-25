@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
if defined MOZARIE_PYTHON (set "PYTHON=%MOZARIE_PYTHON%") else set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"
if not defined MOZARIE_PYTHON if not exist "%PYTHON%" call :bootstrap
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
echo [Mozarie] Python 3.11 or newer is required. Set MOZARIE_PYTHON or run setup.bat.
pause
exit /b 1

:bootstrap
py -3.11 -m venv "%APP_DIR%.venv" >nul 2>nul
if errorlevel 1 python -m venv "%APP_DIR%.venv"
if errorlevel 1 exit /b 1
"%PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 exit /b 1
"%PYTHON%" -m pip install -r "%APP_DIR%requirements.txt"
exit /b %ERRORLEVEL%

:validate_python
"%PYTHON%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
exit /b %ERRORLEVEL%

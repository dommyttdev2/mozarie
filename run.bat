@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
if defined MOZARIE_PYTHON set "PYTHON=%MOZARIE_PYTHON%"
if defined MOZARIE_PYTHON goto :python_selected
set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"

:python_selected
if not exist "%PYTHON%" goto :setup_required
call :validate_python
if errorlevel 1 goto :setup_required
if defined MOZARIE_PYTHON goto :start
if not exist "%APP_DIR%.venv\.mozarie-ready" goto :setup_required
:start
"%PYTHON%" "%APP_DIR%server.py"
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" exit /b 0
echo Mozarie stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

:validate_python
"%PYTHON%" -c "import struct, sys; raise SystemExit(0 if (3, 11) <= sys.version_info < (3, 15) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
exit /b %ERRORLEVEL%

:setup_required
echo [Mozarie] Initial setup is required. Run setup.bat once, then start with run.bat.
pause
exit /b 1

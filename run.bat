@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
if defined MOZARIE_PYTHON (
  set "PYTHON=%MOZARIE_PYTHON%"
) else (
  set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"
  if not exist "%PYTHON%" (
    call :create_venv
    if errorlevel 1 goto :missing_python
    set "NEW_VENV=1"
  )
)
if not exist "%PYTHON%" goto :missing_python
call :validate_python
if errorlevel 1 goto :missing_python
if defined NEW_VENV (
  "%PYTHON%" -m pip install -r "%APP_DIR%requirements.txt"
  if errorlevel 1 goto :setup_failed
)

"%PYTHON%" "%APP_DIR%server.py"
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" exit /b 0
echo Mozarie stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

:create_venv
for %%V in (3.14-64 3.13-64 3.12-64 3.11-64) do (
  py -%%V -m venv "%APP_DIR%.venv" >nul 2>nul
  if not errorlevel 1 goto :venv_ready
)
exit /b 1

:venv_ready
if not exist "%PYTHON%" exit /b 1
exit /b 0

:validate_python
"%PYTHON%" -c "import struct, sys; raise SystemExit(0 if (3, 11) <= sys.version_info < (3, 15) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
exit /b %ERRORLEVEL%

:missing_python
echo [Mozarie] 64-bit Python 3.11 to 3.14 was not found. Install it, then run setup.bat.
pause
exit /b 1

:setup_failed
echo [Mozarie] Initial setup failed. Run setup.bat.
pause
exit /b 1

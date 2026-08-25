@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"

if not exist "%PYTHON%" call :create_venv
if errorlevel 1 goto :missing_python
if not exist "%PYTHON%" goto :missing_python
call :validate_python
if errorlevel 1 goto :python_too_old

"%PYTHON%" -m pip install --upgrade pip
if errorlevel 1 goto :failed
"%PYTHON%" -m pip install -r "%APP_DIR%requirements.txt"
if errorlevel 1 goto :failed
echo [Mozarie] Setup complete. Run run.bat.
pause
exit /b 0

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

:failed
echo [Mozarie] Setup failed. .venv was left in place for inspection.
pause
exit /b 1

:missing_python
echo [Mozarie] 64-bit Python 3.11 to 3.14 was not found. Install it, then run setup.bat again.
pause
exit /b 1

:python_too_old
echo [Mozarie] .venv needs 64-bit Python 3.11 to 3.14. Remove .venv and run setup.bat again.
pause
exit /b 1

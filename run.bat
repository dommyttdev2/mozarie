@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
set "PYTHON="
set "PYTHON_ARGS="

if defined MOZARIE_PYTHON (
  if exist "%MOZARIE_PYTHON%" (
    set "PYTHON=%MOZARIE_PYTHON%"
  ) else (
    echo [Mozarie] MOZARIE_PYTHON does not point to a Python executable.
    goto :missing_python
  )
)
if not defined PYTHON if exist "%APP_DIR%.venv\Scripts\python.exe" set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"
if not defined PYTHON if exist "%APP_DIR%..\ComfyUI_windows_portable\python_embeded\python.exe" set "PYTHON=%APP_DIR%..\ComfyUI_windows_portable\python_embeded\python.exe"
if not defined PYTHON (
  py -3.11 -c "import sys" >nul 2>nul
  if not errorlevel 1 (
    set "PYTHON=py"
    set "PYTHON_ARGS=-3.11"
  )
)
if not defined PYTHON (
  where python >nul 2>nul
  if not errorlevel 1 set "PYTHON=python"
)
if not defined PYTHON goto :missing_python

"%PYTHON%" %PYTHON_ARGS% "%APP_DIR%server.py"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo Mozarie stopped with exit code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%

:missing_python
echo [Mozarie] Python 3.11 was not found. Set MOZARIE_PYTHON or create .venv.
pause
exit /b 1

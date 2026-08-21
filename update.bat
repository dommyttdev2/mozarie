@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
set "PYTHON="
set "PYTHON_ARGS="

if defined MOZARIE_PYTHON (
  if exist "%MOZARIE_PYTHON%" (
    set "PYTHON=%MOZARIE_PYTHON%"
    call :validate_python
    if errorlevel 1 goto :invalid_mozarie_python
  ) else (
    goto :invalid_mozarie_python
  )
)
if not defined PYTHON if exist "%APP_DIR%.venv\Scripts\python.exe" (
  set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"
  call :validate_python
  if errorlevel 1 set "PYTHON="
)
if not defined PYTHON if exist "%APP_DIR%..\ComfyUI_windows_portable\python_embeded\python.exe" (
  set "PYTHON=%APP_DIR%..\ComfyUI_windows_portable\python_embeded\python.exe"
  call :validate_python
  if errorlevel 1 set "PYTHON="
)
if not defined PYTHON (
  for /f "tokens=1" %%V in ('py -0p 2^>nul ^| findstr /r /c:"-V:3\.[0-9][0-9]*"') do (
    if not defined PYTHON (
      set "PYTHON=py"
      set "PYTHON_ARGS=%%V"
      call :validate_python
      if errorlevel 1 (
        set "PYTHON="
        set "PYTHON_ARGS="
      )
    )
  )
)
if not defined PYTHON (
  where python >nul 2>nul
  if not errorlevel 1 (
    set "PYTHON=python"
    call :validate_python
    if errorlevel 1 set "PYTHON="
  )
)
if not defined PYTHON goto :missing_python

"%PYTHON%" %PYTHON_ARGS% -X utf8 "%APP_DIR%updater.py"
set "EXIT_CODE=%ERRORLEVEL%"
goto :finish

:invalid_mozarie_python
echo [Mozarie] MOZARIE_PYTHON is invalid. / MOZARIE_PYTHON が正しくありません。
set "EXIT_CODE=1"
goto :finish

:missing_python
echo [Mozarie] Python 3.11+ was not found. / Python 3.11 以上が見つかりません。
set "EXIT_CODE=1"

:finish
pause
exit /b %EXIT_CODE%

:validate_python
"%PYTHON%" %PYTHON_ARGS% -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
exit /b %ERRORLEVEL%

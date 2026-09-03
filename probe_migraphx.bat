@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
set "VENV=%LOCALAPPDATA%\Mozarie\migraphx-probe-venv"
set "PYTHON=%VENV%\Scripts\python.exe"

if not exist "%PYTHON%" (
  for %%V in (3.14-64 3.13-64 3.12-64 3.11-64) do (
    py -%%V -c "import sys; raise SystemExit(0)" >nul 2>nul
    if not errorlevel 1 (
      py -%%V -m venv "%VENV%"
      if not errorlevel 1 goto :venv_ready
    )
  )
  echo [Mozarie] MIGraphX probe needs 64-bit Python 3.11 to 3.14.
  exit /b 1
)

:venv_ready
if not exist "%PYTHON%" (
  echo [Mozarie] Could not create the dedicated MIGraphX probe environment.
  exit /b 1
)

"%PYTHON%" -m pip install --disable-pip-version-check --upgrade pip
if errorlevel 1 exit /b 1
"%PYTHON%" -m pip install --disable-pip-version-check -r "%APP_DIR%requirements-migraphx-probe.txt"
if errorlevel 1 exit /b 1
"%PYTHON%" -m pip check
if errorlevel 1 exit /b 1

pushd "%APP_DIR%"
"%PYTHON%" -X utf8 -c "from mozarie.migraphx_probe import main; raise SystemExit(main())" %*
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%

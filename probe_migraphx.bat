@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
set "VENV=%LOCALAPPDATA%\Mozarie\migraphx-probe-venv"
set "PYTHON=%VENV%\Scripts\python.exe"
set "BASE_PYTHON="

if exist "%PYTHON%" (
  "%PYTHON%" -c "import struct, sys; raise SystemExit(0 if (3, 11) <= sys.version_info < (3, 14) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
  if errorlevel 1 (
    echo [Mozarie] Recreating the dedicated MIGraphX probe environment with Python 3.11 to 3.13...
    rmdir /s /q "%VENV%"
    if exist "%VENV%" (
      echo [Mozarie] Could not remove the incompatible MIGraphX probe environment.
      exit /b 1
    )
  )
)

if not exist "%PYTHON%" (
  call :find_base_python
  if not defined BASE_PYTHON (
    echo [Mozarie] MIGraphX probe needs an installed 64-bit Python 3.11, 3.12, or 3.13 runtime.
    echo [Mozarie] Installed runtimes reported by Python Install Manager:
    py list
    exit /b 1
  )
  "%BASE_PYTHON%" -c "import struct, sys; raise SystemExit(0 if (3, 11) <= sys.version_info < (3, 14) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
  if errorlevel 1 (
    echo [Mozarie] Selected Python runtime is not a supported 64-bit Python 3.11 to 3.13 interpreter.
    exit /b 1
  )
  echo [Mozarie] Creating the dedicated MIGraphX probe environment with:
  "%BASE_PYTHON%" --version
  "%BASE_PYTHON%" -m venv "%VENV%"
  if errorlevel 1 (
    echo [Mozarie] Could not create the dedicated MIGraphX probe environment.
    exit /b 1
  )
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

:find_base_python
for %%V in (3.13 3.12 3.11) do (
  if not defined BASE_PYTHON for /f "usebackq delims=" %%P in (`py list --one --format=exe %%V 2^>nul`) do (
    if exist "%%P" set "BASE_PYTHON=%%P"
  )
)
exit /b 0

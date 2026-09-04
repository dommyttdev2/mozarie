@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
set "VENV=%LOCALAPPDATA%\Mozarie\rocm-probe-venv"
set "PYTHON=%VENV%\Scripts\python.exe"
set "BASE_PYTHON="

if exist "%PYTHON%" (
  "%PYTHON%" -c "import struct, sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
  if errorlevel 1 goto :recreate_venv
  goto :venv_ready
)

goto :create_venv

:recreate_venv
echo [Mozarie] Recreating the dedicated ROCm probe environment with 64-bit Python 3.12...
rmdir /s /q "%VENV%"
if exist "%VENV%" (
  echo [Mozarie] Could not remove the incompatible ROCm probe environment.
  exit /b 1
)

:create_venv
for /f "usebackq delims=" %%P in (`py list --one --format=exe 3.12 2^>nul`) do (
  if exist "%%P" set "BASE_PYTHON=%%P"
)
if not defined BASE_PYTHON goto :missing_python

echo [Mozarie] Selected Python runtime:
"%BASE_PYTHON%" --version
"%BASE_PYTHON%" -c "import struct, sys; print(sys.executable); print(str(struct.calcsize('P') * 8) + '-bit')"
if errorlevel 1 exit /b 1

"%BASE_PYTHON%" -m venv "%VENV%"
if errorlevel 1 (
  echo [Mozarie] Could not create the dedicated ROCm probe environment.
  exit /b 1
)

goto :venv_ready

:missing_python
echo [Mozarie] ROCm probe needs an installed 64-bit Python 3.12 runtime.
echo [Mozarie] Installed runtimes reported by Python Install Manager:
py list
exit /b 1

:venv_ready
if not exist "%PYTHON%" (
  echo [Mozarie] Could not create the dedicated ROCm probe environment.
  exit /b 1
)

"%PYTHON%" -m pip install --disable-pip-version-check --upgrade pip
if errorlevel 1 exit /b 1
"%PYTHON%" -m pip install --disable-pip-version-check --index-url https://repo.amd.com/rocm/whl/gfx103X-all/ -r "%APP_DIR%requirements-rocm-probe.txt"
if errorlevel 1 exit /b 1
"%PYTHON%" -m pip check
if errorlevel 1 exit /b 1

pushd "%APP_DIR%"
"%PYTHON%" -X utf8 -c "from mozarie.rocm_probe import main; raise SystemExit(main())" %*
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%

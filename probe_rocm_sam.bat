@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
set "VENV=%LOCALAPPDATA%\Mozarie\rocm-probe-venv"
set "PYTHON=%VENV%\Scripts\python.exe"

rem Re-run the base ROCm gate first so this probe never continues with an
rem incompatible Python, non-ROCm PyTorch build, or the wrong gfx device.
call "%APP_DIR%probe_rocm.bat" %*
if errorlevel 1 exit /b 1

if not exist "%PYTHON%" (
  echo [Mozarie] The dedicated ROCm probe environment is unavailable.
  exit /b 1
)

"%PYTHON%" -m pip install --disable-pip-version-check -r "%APP_DIR%requirements-rocm-sam-probe.txt"
if errorlevel 1 exit /b 1
"%PYTHON%" -m pip check
if errorlevel 1 exit /b 1

pushd "%APP_DIR%"
"%PYTHON%" -X utf8 -c "from mozarie.rocm_sam_probe import main; raise SystemExit(main())" %*
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%

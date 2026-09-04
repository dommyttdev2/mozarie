@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
set "VENV=%LOCALAPPDATA%\Mozarie\rocm-probe-venv"
set "PYTHON=%VENV%\Scripts\python.exe"

rem Re-run the SAM ROCm gate first. This also guarantees that the dedicated
rem environment contains the exact ROCm PyTorch and torchvision builds used by Mozarie.
call "%APP_DIR%probe_rocm_sam.bat" %*
if errorlevel 1 exit /b 1

if not exist "%PYTHON%" (
  echo [Mozarie] The dedicated ROCm probe environment is unavailable.
  exit /b 1
)

rem Install ONNX Runtime DirectML without torch-directml. The purpose of this
rem gate is to prove that DirectML ONNX and ROCm PyTorch coexist in one process.
"%PYTHON%" -m pip install --disable-pip-version-check -r "%APP_DIR%requirements-rocm-directml-probe.txt"
if errorlevel 1 exit /b 1
"%PYTHON%" -m pip check
if errorlevel 1 exit /b 1

pushd "%APP_DIR%"
"%PYTHON%" -X utf8 -c "from mozarie.rocm_directml_probe import main; raise SystemExit(main())" %*
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%

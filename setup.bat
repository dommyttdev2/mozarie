@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
if /i "%~1"=="--locked" goto :locked
for %%V in (3.14-64 3.13-64 3.12-64 3.11-64) do (
  py -%%V -c "import sys; raise SystemExit(0)" >nul 2>nul
  if not errorlevel 1 (
    py -%%V -X utf8 "%APP_DIR%updater.py" --check-running
    if errorlevel 30 if not errorlevel 31 goto :mozarie_running
    py -%%V -X utf8 "%APP_DIR%updater.py" --run-setup-locked
    if errorlevel 1 goto :setup_locked_failed
    exit /b 0
  )
)
echo [Mozarie] 64-bit Python 3.11 to 3.14 was not found. Install it, then run setup.bat again. / 64-bit Python 3.11〜3.14 をインストールしてから setup.bat を実行してください。
exit /b 1

:locked
set "PYTHON=%APP_DIR%.venv\Scripts\python.exe"
set "RUNTIME=%MOZARIE_RUNTIME%"
if not defined RUNTIME if exist "%APP_DIR%.venv\.mozarie-runtime.json" for /f "usebackq delims=" %%R in (`powershell.exe -NoProfile -Command "try { (Get-Content -Raw -LiteralPath '%APP_DIR%.venv\.mozarie-runtime.json' | ConvertFrom-Json).profile } catch { exit 1 }"`) do set "RUNTIME=%%R"
if not defined RUNTIME for /f "usebackq delims=" %%R in (`powershell.exe -NoProfile -Command "$gpu=@(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.PNPDeviceID -like 'PCI*' }); if ($gpu.PNPDeviceID -match 'VEN_10DE') { 'cuda' } elseif ($gpu.PNPDeviceID -match 'VEN_1002') { 'directml' } else { 'cuda' }"`) do set "RUNTIME=%%R"
if /i "%RUNTIME%"=="cuda" goto :runtime_ready
if /i "%RUNTIME%"=="directml" goto :runtime_ready
if /i "%RUNTIME%"=="cpu" goto :runtime_ready
goto :invalid_runtime

:runtime_ready
echo [Mozarie] [1/5] Checking Python environment...
if not exist "%PYTHON%" call :create_venv
if errorlevel 1 goto :venv_failed
if not exist "%PYTHON%" goto :venv_failed
call :validate_python
if errorlevel 1 goto :python_too_old
pushd "%APP_DIR%"
"%PYTHON%" -m mozarie.runtime_profile preflight "%RUNTIME%" --venv "%APP_DIR%.venv"
set "RUNTIME_CHECK=%ERRORLEVEL%"
popd
if not "%RUNTIME_CHECK%"=="0" goto :runtime_mismatch

echo [Mozarie] [2/5] Preparing the installer...
"%PYTHON%" -m pip install --disable-pip-version-check --no-cache-dir --progress-bar on --upgrade pip
if errorlevel 1 goto :failed
echo [Mozarie] [3/5] Installing required packages. This may download several GB on the first run.
del /q "%APP_DIR%.venv\.mozarie-ready" >nul 2>nul
echo [Mozarie] Runtime: %RUNTIME%
set "REQUIREMENTS=%APP_DIR%requirements.txt"
if /i "%RUNTIME%"=="directml" set "REQUIREMENTS=%APP_DIR%mozarie\requirements-directml.txt"
if /i "%RUNTIME%"=="cpu" set "REQUIREMENTS=%APP_DIR%mozarie\requirements-cpu.txt"
"%PYTHON%" -m pip install --disable-pip-version-check --progress-bar on -r "%REQUIREMENTS%"
if errorlevel 1 goto :failed
echo [Mozarie] [4/5] Checking installed packages...
"%PYTHON%" -m pip check
if errorlevel 1 goto :failed
echo [Mozarie] [5/5] Checking runtime support...
pushd "%APP_DIR%"
"%PYTHON%" -m mozarie.runtime_profile validate "%RUNTIME%" --venv "%APP_DIR%.venv" --write-marker
set "RUNTIME_CHECK=%ERRORLEVEL%"
popd
if not "%RUNTIME_CHECK%"=="0" goto :failed
"%PYTHON%" -X utf8 "%APP_DIR%setup_gpu_check.py"
if errorlevel 1 goto :failed
:setup_ready
>"%APP_DIR%.venv\.mozarie-ready" echo ready
echo [Mozarie] Setup complete. Run run.bat.
pause
exit /b 0

:setup_locked_failed
exit /b 1

:create_venv
if /i "%RUNTIME%"=="directml" goto :create_directml_venv
if /i "%RUNTIME%"=="cpu" goto :create_directml_venv
for %%V in (3.14-64 3.13-64 3.12-64 3.11-64) do (
  py -%%V -m venv "%APP_DIR%.venv"
  if not errorlevel 1 goto :venv_ready
)
exit /b 1

:create_directml_venv
for %%V in (3.12-64 3.11-64) do (
  py -%%V -m venv "%APP_DIR%.venv" >nul 2>nul
  if not errorlevel 1 goto :venv_ready
)
exit /b 1

:venv_ready
if not exist "%PYTHON%" exit /b 1
exit /b 0

:validate_python
if /i "%RUNTIME%"=="cuda" "%PYTHON%" -c "import struct, sys; raise SystemExit(0 if (3, 11) <= sys.version_info < (3, 15) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
if /i not "%RUNTIME%"=="cuda" "%PYTHON%" -c "import struct, sys; raise SystemExit(0 if (3, 11) <= sys.version_info < (3, 13) and struct.calcsize('P') == 8 else 1)" >nul 2>nul
exit /b %ERRORLEVEL%

:failed
echo [Mozarie] Setup failed. Check the message above and run setup.bat again.
echo [Mozarie] If Windows denied access, close other setup windows and run setup.bat again. Administrator rights are not required. / Windowsにアクセスを拒否された場合は、ほかのsetupを閉じてsetup.batを再実行してください。管理者として実行する必要はありません。
pause
exit /b 1

:mozarie_running
echo [Mozarie] Close Mozarie, then run setup.bat again. / Mozarieを終了してから、もう一度 setup.bat を実行してください。
pause
exit /b 1

:missing_python
echo [Mozarie] 64-bit Python 3.11 to 3.14 was not found. Install it, then run setup.bat again.
pause
exit /b 1

:venv_failed
echo [Mozarie] Could not create the Python environment. Check the message above, free disk space or folder access, then run setup.bat again. / Python環境を作成できませんでした。上のメッセージを確認し、空き容量またはフォルダへのアクセスを確認してから setup.bat を再実行してください。
pause
exit /b 1

:python_too_old
if /i "%RUNTIME%"=="cuda" echo [Mozarie] CUDA needs 64-bit Python 3.11 to 3.14. Remove .venv and run setup.bat again.
if /i not "%RUNTIME%"=="cuda" echo [Mozarie] DirectML and CPU need 64-bit Python 3.11 or 3.12. Remove .venv and run setup.bat again.
pause
exit /b 1

:invalid_runtime
echo [Mozarie] MOZARIE_RUNTIME must be cuda, directml, or cpu.
pause
exit /b 1

:runtime_mismatch
echo [Mozarie] The existing .venv uses another or inconsistent runtime. It was not modified.
echo [Mozarie] Back up or remove .venv, then run setup.bat again.
pause
exit /b 1

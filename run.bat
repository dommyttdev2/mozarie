@echo off
setlocal
set "APP_DIR=%~dp0"
set "PYTHON=G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\python_embeded\python.exe"

if not exist "%PYTHON%" (
  echo Portable Python was not found:
  echo %PYTHON%
  pause
  exit /b 1
)

"%PYTHON%" "%APP_DIR%server.py"
pause

@echo off
chcp 65001 >nul
setlocal
set "APP_DIR=%~dp0"
set "PYTHON=G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\python_embeded\python.exe"

if not exist "%PYTHON%" (
  echo Portable Python が見つかりません:
  echo %PYTHON%
  pause
  exit /b 1
)

"%PYTHON%" "%APP_DIR%server.py"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo 起動または実行中にエラーが発生しました。終了コード: %EXIT_CODE%
)
pause
exit /b %EXIT_CODE%

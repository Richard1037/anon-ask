@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   匿名提问箱
echo   ----------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Node.js。
  echo.
  echo   请先安装 Node.js 22 或更高版本：https://nodejs.org/
  echo   安装后重新运行本脚本。
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo   Node 版本 %NODEVER%
echo   正在启动，关闭这个窗口即可停止服务。
echo.

node server.js

echo.
echo   服务已停止。
pause

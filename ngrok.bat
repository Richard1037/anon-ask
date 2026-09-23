@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Node.js，请先安装：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node ngrok.mjs

echo.
echo   隧道已停止。按任意键关闭窗口。
pause >nul

@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
if not exist "data\public-url.txt" (
  echo   还没有公网地址 —— 先双击 tunnel.bat 开启隧道。
  echo.
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

echo   ============================================================
echo    当前公网地址（把这一行发给你想分享的人）
echo   ============================================================
echo.
type data\public-url.txt
echo.
echo    管理后台：在上面地址后面加 /admin
echo.
echo   提示：临时地址每次重连都会变，以这个文件里的为准。
echo         想固定地址请看 README 的「让别人从公网打开」。
echo.
ping -n 5 127.0.0.1 >nul

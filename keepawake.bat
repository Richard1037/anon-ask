@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   ========================================
echo    防待机守护（不需要管理员权限）
echo   ========================================
echo.
echo   作用：阻止 Windows 因闲置进入睡眠 / Modern Standby。
echo.
echo   保持这个窗口开着；关掉窗口就停止防待机。
echo.
pause >nul

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0keepawake.ps1"

echo.
echo   防待机已停止。
pause >nul

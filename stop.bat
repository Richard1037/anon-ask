@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   正在停止匿名提问箱...
echo.

rem 注意：这里必须用 !VAR! 而不是 %VAR%。set /p 和 taskkill 在同一个括号块里，
rem 用 %VAR% 会在解析阶段就展开（那时变量还是空的），拿到的是空 pid。

rem ---- 隧道守护进程（必须先停，否则它会立刻把隧道客户端拉起来）----
call :StopDaemon "data\ngrok.pid"       "ngrok"
call :StopDaemon "data\tunnel.pid"      "Cloudflare 隧道"

rem 兜底：清掉可能残留的客户端进程
taskkill /im cloudflared.exe /f >nul 2>nul
taskkill /im ngrok.exe /f >nul 2>nul

rem ---- 网站服务 ----
if exist "data\server.pid" (
  set /p SERVERPID=<"data\server.pid"
  taskkill /pid !SERVERPID! /t /f >nul 2>nul
  if errorlevel 1 (
    echo   [网站] 进程 !SERVERPID! 已经不在运行了。
  ) else (
    echo   [网站] 已停止（pid !SERVERPID!）。
  )
  del "data\server.pid" >nul 2>nul
) else (
  echo   [网站] 没有在运行。
)

echo.
ping -n 3 127.0.0.1 >nul
exit /b 0

rem ------------------------------------------------------------------
:StopDaemon
rem %1 = pid 文件路径   %2 = 显示名称
if not exist "%~1" (
  echo   [%~2] 没有在运行。
  exit /b 0
)
set /p DPID=<"%~1"
taskkill /pid !DPID! /t /f >nul 2>nul
if errorlevel 1 (
  echo   [%~2] 守护进程 !DPID! 已经不在运行了。
) else (
  echo   [%~2] 已停止（守护进程 !DPID!）。
)
del "%~1" >nul 2>nul
exit /b 0

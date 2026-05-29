@echo off
cd /d "%~dp0"
title MirrorHub - Control Panel Launcher
color 0b

echo ==========================================================
echo         MirrorHub Control Panel One-Click Launcher
echo ==========================================================
echo.
echo [1/2] Checking Node.js runtime environment...

node -v >nul 2>&1
if %errorlevel% neq 0 (
    color 0c
    echo [ERROR] Node.js is not installed! Please install Node.js 18 or higher.
    echo Download link: https://nodejs.org/
    echo.
    pause
    exit /b
)

echo [SUCCESS] Node.js is active:
for /f "tokens=*" %%i in ('node -v') do set LAUNCHER_NODE_VER=%%i
echo %LAUNCHER_NODE_VER%
echo.
echo [2/2] Starting Control Panel Service...
echo ----------------------------------------------------------
echo.
echo [ONLINE] Automatically opening dashboard in browser: http://localhost:4000/
echo.
echo [TIP] Keep this terminal window open to keep the proxy server active.
echo.
echo ==========================================================
echo.

node MirrorLauncher\launcher.js
pause

@echo off
chcp 65001 >nul
title 抖音视频文字稿提取服务
cd /d "%~dp0"

echo.
echo ========================================
echo   抖音视频文字稿提取 - 本地服务
echo ========================================
echo.

where node >nul 2>nul
if %errorlevel%==0 (
  set NODE_CMD=node
) else (
  set NODE_CMD=C:\Users\Admin\.workbuddy\binaries\node\versions\22.22.2\node.exe
)

echo 正在启动服务...
echo 启动后请在浏览器打开: http://localhost:3000
echo 按 Ctrl+C 可停止服务
echo.

"%NODE_CMD%" server/index.js

pause

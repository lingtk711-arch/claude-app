@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Claude App
echo.
echo   正在启动 Claude App...  浏览器会自动打开
echo   保持本窗口开着；关掉本窗口即停止服务。
echo.
node server.js
echo.
echo   服务已停止。
pause

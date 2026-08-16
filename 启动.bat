@echo off
chcp 65001 >nul
title Kimi Code Token 监控
cd /d "%~dp0"

echo 正在启动 Kimi Code Token 监控 ...
echo 数据根：C:\Users\%USERNAME%\.kimi-code\sessions
echo 纯本地服务，按 Ctrl+C 退出
echo.

start "" http://127.0.0.1:8787
python server.py --port 8787

pause

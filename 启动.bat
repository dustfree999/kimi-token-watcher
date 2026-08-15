@echo off
title Kimi Code Token 监控
cd /d "%~dp0"

echo 正在启动本地服务 ...
echo 若浏览器未自动打开，请手动访问 http://127.0.0.1:8787
echo 按 Ctrl+C 可停止
echo.

start "" http://127.0.0.1:8787
python server.py --port 8787

pause
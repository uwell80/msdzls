@echo off
rem 单机版《美食大战老鼠》本地服务端启动脚本
rem HTTP 8080 + 游戏网关 18443/18444/18445/18446，日志写到同目录 server.log / server.err
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" local-server.mjs > server.log 2> server.err

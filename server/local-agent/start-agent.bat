@echo off
rem Start the LTC local agent terminal server in the background.
rem Used by setup-windows.bat and the login auto-start VBS.
rem Reads server/local-agent/config.json (port, yjsUrl, token) automatically.
cd /d "%~dp0"
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
set "NODE_PATH=%CD%\node_modules"
node ..\terminal-server.js

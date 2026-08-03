@echo off
rem ============================================================
rem  LTC Local Agent - one-time Windows setup
rem  Run this ONCE on your own machine (double-click). It will:
rem    1. use system Node.js or download a portable one (~30MB)
rem    2. install dependencies (ws, node-pty)
rem    3. ask you for the server IP + agent token (once)
rem    4. register auto-start at login (hidden background server)
rem    5. start the local agent terminal now
rem  Afterwards you never touch it again - open the web app,
rem  click the "Local Agent" tab in the output panel.
rem  Re-run this script to repair or reconfigure (delete
rem  config.json first to be asked again).
rem ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "AGENT_DIR=%CD%\"

echo.
echo ============================================
echo   LTC Local Agent - Windows setup (one time)
echo ============================================
echo.

rem ---- 1. Locate Node.js (system or portable) ----
set "NODE_BIN=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "%AGENT_DIR%node\node.exe" (
    set "NODE_BIN=%AGENT_DIR%node\node.exe"
  ) else (
    echo [1/4] No Node.js found - downloading portable Node.js ~30MB...
    set "NODE_VERSION=v20.19.1"
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "Invoke-WebRequest -Uri 'https://nodejs.org/dist/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip' -OutFile '%AGENT_DIR%node.zip'"
    if errorlevel 1 (
      echo ERROR: Node.js download failed. Install Node.js manually from https://nodejs.org and re-run.
      exit /b 1
    )
    tar -xf "%AGENT_DIR%node.zip" -C "%AGENT_DIR%"
    if errorlevel 1 (
      echo ERROR: extracting Node.js failed.
      exit /b 1
    )
    move /y "%AGENT_DIR%node-%NODE_VERSION%-win-x64" "%AGENT_DIR%node" >nul
    del "%AGENT_DIR%node.zip"
    set "NODE_BIN=%AGENT_DIR%node\node.exe"
  )
)
echo [1/4] Node.js: %NODE_BIN%

rem ---- 2. Install dependencies (ws, node-pty) ----
echo [2/4] Installing dependencies (ws, node-pty) - first run may take a minute...
set "NPM=npm"
if exist "%AGENT_DIR%node\npm.cmd" set "NPM=%AGENT_DIR%node\npm.cmd"
call "%NPM%" install --no-audit --no-fund
if errorlevel 1 (
  echo ERROR: npm install failed. Check your network and re-run.
  exit /b 1
)

rem ---- 3. First-time configuration ----
if not exist "%AGENT_DIR%config.json" (
  echo [3/4] First-time configuration - you need:
  echo         * the server IP you open in your browser ^(e.g. 192.168.1.10^)
  echo         * the agent token: run on the SERVER:
  echo             cat ~/LTC/server/.terminal-token
  echo.
  set /p SERVER_IP=Server IP: 
  set /p TOKEN=Agent token: 
  set /p PORT=Local port [8085]: 
  if "!PORT!"=="" set "PORT=8085"
  if "!SERVER_IP!"=="" set "SERVER_IP=localhost"
  (
    echo {
    echo   "port": "!PORT!",
    echo   "yjsUrl": "http://!SERVER_IP!:8082",
    echo   "token": "!TOKEN!"
    echo }
  ) > "%AGENT_DIR%config.json"
  echo Config saved to %AGENT_DIR%config.json
)

rem ---- 4. Auto-start at login (hidden) ----
echo [4/4] Registering auto-start at login...
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP%" (
  (
    echo Set WshShell = CreateObject^("WScript.Shell"^)
    echo WshShell.CurrentDirectory = "%AGENT_DIR%"
    echo WshShell.Run """%AGENT_DIR%start-agent.bat""", 0, False
  ) > "%STARTUP%\ltc-agent.vbs"
  echo Auto-start registered. To remove it later, delete:
  echo   %STARTUP%\ltc-agent.vbs
) else (
  echo WARNING: Startup folder not found - auto-start NOT registered.
  echo You can start it manually anytime with: %AGENT_DIR%start-agent.bat
)

rem ---- 5. Start now ----
echo.
echo Starting local agent terminal (background)...
start "" /b "%AGENT_DIR%start-agent.bat"
echo.
echo ============================================
echo  DONE! Open the web app and click the
echo  "Local Agent" tab (output panel).
echo  It connects to ws://127.0.0.1:%PORT%
echo ============================================
echo.
pause

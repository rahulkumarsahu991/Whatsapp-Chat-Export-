@echo off
title WhatsApp Chat Exporter 3D
cd /d "%~dp0"

rem Use the portable Node.js kept in %LOCALAPPDATA%\WhatsAppChatExporter\node when Node isn't installed system-wide.
where node >nul 2>nul
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\WhatsAppChatExporter\node\node.exe" set "PATH=%LOCALAPPDATA%\WhatsAppChatExporter\node;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Install the LTS version from https://nodejs.org and then run start.bat again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\whatsapp-web.js" (
  echo.
  echo   First run: installing required packages - this takes a few minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Package install failed. Check your internet connection and run start.bat again.
    pause
    exit /b 1
  )
)

node server.js %*
pause

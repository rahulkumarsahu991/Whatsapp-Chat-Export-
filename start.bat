@echo off
title WhatsApp Chat Exporter
cd /d "%~dp0"

rem Use the portable Node.js in %LOCALAPPDATA%\WhatsAppChatExporter\node when it is there (no admin install needed).
if exist "%LOCALAPPDATA%\WhatsAppChatExporter\node\node.exe" set "PATH=%LOCALAPPDATA%\WhatsAppChatExporter\node;%PATH%"

node -v >nul 2>&1
if errorlevel 1 goto nonode

if not exist "node_modules\whatsapp-web.js" call :install
if errorlevel 1 goto end

node server.js %*
goto end

:install
echo.
echo   First run: installing required packages - this takes a few minutes...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo   Package install failed. Check your internet connection and try again.
  exit /b 1
)
exit /b 0

:nonode
echo.
echo   Node.js was not found.
echo   Install the LTS version from https://nodejs.org and then run this again.
echo.

:end
pause

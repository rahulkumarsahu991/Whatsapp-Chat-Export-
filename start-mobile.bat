@echo off
title WhatsApp Chat Exporter - phone access
cd /d "%~dp0"

rem Use the portable Node.js in %USERPROFILE%\WhatsAppChatExporter\node when it is there (no admin install needed).
if exist "%USERPROFILE%\WhatsAppChatExporter\node\node.exe" set "PATH=%USERPROFILE%\WhatsAppChatExporter\node;%PATH%"

node -v >nul 2>&1
if errorlevel 1 goto nonode

if not exist "node_modules\compression" call :install
if errorlevel 1 goto end

rem Runs the exporter on this PC and opens it to your phone through a Google-protected ngrok link.
rem Add --setup to change the ngrok token, link or allowed Google emails.
node mobile.js %*
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

@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found.
  echo Please install Node.js 12 or newer from https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting H3C Warranty Workbench ...
echo   A browser window will open automatically.
echo   Keep this window open while using the tool. Press Ctrl+C to stop.
echo.
node server.js
echo.
echo   Server stopped.
pause

@echo off
setlocal
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org/en/download/archive/v24
  echo Then open this file again.
  pause
  exit /b 1
)
node.exe "%~dp0preview-server.cjs"
if errorlevel 1 pause

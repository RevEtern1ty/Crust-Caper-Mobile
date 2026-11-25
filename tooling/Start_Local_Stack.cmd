@echo off
if exist "%~dp0local-stack.cjs" (
  node "%~dp0local-stack.cjs"
) else (
  node "%~dp0tooling\local-stack.cjs"
)
if errorlevel 1 pause

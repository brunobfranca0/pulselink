@echo off
title PulseLink Desktop Launcher
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
echo Iniciando PulseLink Desktop...
node apps\desktop\launch.mjs
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo [ERRO] Falha ao iniciar o PulseLink Desktop (Codigo %ERRORLEVEL%).
  pause
)

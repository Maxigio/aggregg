@echo off
REM Doppio-click su Windows (Surface). Avvia il launcher nodo in loop.
cd /d %~dp0\..
node worker\node-start.js
pause

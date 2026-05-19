@echo off
chcp 65001 >nul
cd /d "%~dp0"
cd launcher
npm install
node server.js
pause

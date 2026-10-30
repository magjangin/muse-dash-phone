@echo off
rem Double-click to build and install the Muse Dash mod clone on the USB-connected phone.
rem Options are passed through to install.ps1 (e.g. install.bat -Serial XXXX).
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause

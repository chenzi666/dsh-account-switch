@echo off
rem Double-click entry for swap-desktop-asar.ps1.
rem
rem It waits for DeepSeek Harness to exit, so you can start this first and then
rem close the app - no need to memorise any command before closing it.
setlocal
echo.
echo   DeepSeek Harness - account sign-in browser patch
echo   ---------------------------------------------------------------
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0swap-desktop-asar.ps1" %*
echo.
echo   ---------------------------------------------------------------
echo   Press any key to close this window.
pause >nul

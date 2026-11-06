@echo off
setlocal enabledelayedexpansion
title Codes 0.2
cd /d "%~dp0"

echo.
echo   ======================================================
echo       C O D E S   0.2
echo       Lightweight Development Environment
echo   ======================================================
echo.

REM ---------------------------------------------------------------- Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo  [X] Node.js was not found on this computer.
    echo.
    echo      Codes needs Node.js to run the editor.
    echo      Install the LTS version from https://nodejs.org
    echo      and run START_CODES.bat again.
    echo.
    pause
    exit /b 1
)

REM --------------------------------------------------- Dependencies (1st run)
if not exist "node_modules\electron\package.json" (
    echo  [.] First run detected - installing dependencies.
    echo      This downloads Electron once and can take a few minutes.
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo  [X] npm install failed.
        echo      Check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
)

REM --------------------------------- Electron binary (npm 11 blocks postinstall)
if not exist "node_modules\electron\dist\electron.exe" (
    echo  [.] Downloading the Electron runtime...
    call node "node_modules\electron\install.js"
    if errorlevel 1 (
        echo.
        echo  [X] The Electron runtime could not be downloaded.
        echo.
        pause
        exit /b 1
    )
)

REM --------------------------------------- Keep the import map in sync with deps
echo  [.] Preparing the editor...
call node "scripts\generate-import-map.mjs" >nul 2>&1
call node "scripts\sync-csp.mjs" >nul 2>&1

REM ------------------------------------------------------------------- Launch
echo  [.] Starting Codes...
echo.
if exist "node_modules\.bin\electron.cmd" (
    call "node_modules\.bin\electron.cmd" .
) else (
    call npx electron .
)

if errorlevel 1 (
    echo.
    echo  [X] Codes exited with an error. The message above explains why.
    echo.
    pause
)

endlocal

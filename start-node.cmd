@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

:: Detect port from config (same logic as UMANS-PROXY)
set "PORT=8080"
set "CONFIG_FILE=%~dp0.config\config.json"
if exist "%CONFIG_FILE%" (
    for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "$c=Get-Content '%CONFIG_FILE%' -Raw | ConvertFrom-Json; $l=$c.LISTEN_ADDR; if($l -match ':(?<p>\d+)$'){Write-Output $matches['p']}else{Write-Output '8080'}"`) do set "PORT=%%a"
)

title FREEBUFFProxy - Node.js Mode

echo ==================================================
echo  Freebuff2Opencode Proxy - Node.js Mode
echo  Enforces Node.js (ignores Bun)
echo  http://localhost:%PORT%
echo ==================================================
echo.

echo [1/5] Cleaning up...
:: Kill only whatever is currently listening on the configured port.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [2/5] Detecting Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 goto :no_runtime

echo [INFO] Runtime: Node.js

echo [3/5] Installing dependencies...
call npm install --omit=dev
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm install failed. Try running 'npm install' manually.
    @if not defined OPENCODE_ATTACH timeout /t 10
    exit /b %ERRORLEVEL%
)
if exist "bun.lock" del /F /Q "bun.lock" >nul 2>&1
if exist "package-lock.json" del /F /Q "package-lock.json" >nul 2>&1

echo [4/5] Ensuring config directory...
if not exist ".config" mkdir ".config"

echo [5/5] Starting proxy...
echo.
echo ==================================================
echo  Proxy: http://127.0.0.1:%PORT%
echo  Dashboard: http://127.0.0.1:%PORT%/dashboard
echo ==================================================
echo.

set PROXY_RUNTIME=node

:restart_loop
call npm run start:node

set EXIT_CODE=%ERRORLEVEL%
if %EXIT_CODE% equ 42 (
    echo [INFO] Restarting proxy...
    timeout /t 2 /nobreak >nul
    goto :restart_loop
)
if %EXIT_CODE% equ 0 goto :done
if %EXIT_CODE% equ -1073741819 goto :done
echo.
echo [ERROR] Proxy exited with code %EXIT_CODE%
timeout /t 5 /nobreak >nul
goto :done

:no_runtime
echo [ERROR] Node.js not found in PATH.
echo        Install Node: https://nodejs.org
timeout /t 5 /nobreak >nul

:done
echo.
echo Proxy stopped.
timeout /t 5 /nobreak >nul

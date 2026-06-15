@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

:: Detect port from config
set "PORT=8084"
set "CONFIG_FILE=%~dp0.config\config.json"
if exist "%CONFIG_FILE%" (
    for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "$c=Get-Content '%CONFIG_FILE%' -Raw ^| ConvertFrom-Json; $l=$c.LISTEN_ADDR; if($l -match ':(?<p>\d+)$'){Write-Output $matches['p']}else{Write-Output '8084'}"`) do set "PORT=%%a"
)

taskkill /F /FI "WINDOWTITLE eq UMANSProxy" /T >nul 2>&1
timeout /t 1 /nobreak >nul

title UMANSProxy - Node.js Mode

echo ==================================================
echo  UMANS-Proxy (Node.js) — http://localhost:%PORT%
echo ==================================================

echo [1/3] Cleaning up...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [2/3] Detecting Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 goto :no_runtime

echo [INFO] Runtime: Node.js

echo [3/3] Starting proxy...
echo.
echo ==================================================
echo  Proxy: http://localhost:%PORT%
echo  Dashboard: http://localhost:%PORT%/dashboard
echo ==================================================
echo.

set PROXY_RUNTIME=node

:restart_loop
node proxy.js

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

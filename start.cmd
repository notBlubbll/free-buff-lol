@echo off
setlocal enabledelayedexpansion

taskkill /F /FI "WINDOWTITLE eq UMANSProxy" /T >nul 2>&1
timeout /t 1 /nobreak >nul

cd /d "%~dp0"

:: Detect port from config
set "PORT=8084"
set "CONFIG_FILE=%~dp0.config\config.json"
if exist "%CONFIG_FILE%" (
    for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "$c=Get-Content '%CONFIG_FILE%' -Raw | ConvertFrom-Json; $l=$c.LISTEN_ADDR; if($l -match ':(?<p>\d+)$'){Write-Output $matches['p']}else{Write-Output '8084'}"`) do set "PORT=%%a"
)

title UMANSProxy

echo ==================================================
echo  UMANS-Proxy — http://localhost:%PORT%
echo ==================================================

set "BUN_PATH=C:\WINDOWS\system32\config\systemprofile\.bun\bin"
set "PATH=%BUN_PATH%;%PATH%"

echo [1/3] Cleaning up...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [2/3] Detecting runtime...
where bun >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Runtime: Bun
    set "RUNTIME=bun"
    goto :start
)
where node >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Runtime: Node.js
    set "RUNTIME=node"
    goto :start
)
echo [ERROR] Neither Bun nor Node.js found in PATH.
echo        Install Node: https://nodejs.org
echo        Install Bun:  https://bun.sh
pause
exit

:start
echo [3/3] Starting proxy...
echo.

:restart_loop
if "%RUNTIME%"=="bun" (
    bun run proxy.js
) else (
    node proxy.js
)

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

:done
echo.
echo Proxy stopped.
timeout /t 5 /nobreak >nul

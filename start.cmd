@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo ==================================================
echo  Freebuff2Opencode Proxy
echo ==================================================
echo.

set "BUN_PATH="
where bun >nul 2>&1
if %ERRORLEVEL% equ 0 (
    for /f "delims=" %%b in ('where bun') do (
        if not defined BUN_PATH set "BUN_PATH=%%~dpb"
    )
    goto :bunpathset
)
for %%d in ("%USERPROFILE%\.bun\bin" "%LOCALAPPDATA%\bun\bin" "%APPDATA%\bun\bin" "%PROGRAMFILES%\bun\bin" "%SYSTEMDRIVE%\.bun\bin") do (
    if exist "%%~d\bun.exe" (
        set "BUN_PATH=%%~d"
        goto :bunpathset
    )
)
for /f "delims=" %%u in ('dir /b /ad "C:\Users" 2^>nul') do (
    if exist "C:\Users\%%u\.bun\bin\bun.exe" (
        set "BUN_PATH=C:\Users\%%u\.bun\bin"
        goto :bunpathset
    )
)
:bunpathset
if defined BUN_PATH (
    echo [INFO] Bun found at: %BUN_PATH%
    set "PATH=%BUN_PATH%;%PATH%"
)

echo [1/4] Cleaning up...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080.*LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [2/4] Detecting runtime...
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
timeout /t 5
exit

:start
echo [3/4] Installing dependencies...
if "%RUNTIME%"=="bun" (
    bun install
) else (
    npm install --production
)

echo [4/4] Starting proxy...
echo.
echo ==================================================
echo  Proxy: http://localhost:8080
echo  Dashboard: http://localhost:8080/dashboard
echo ==================================================
echo.

if "%RUNTIME%"=="bun" (
    bun run proxy.js
) else (
    node proxy.js
)

set EXIT_CODE=%ERRORLEVEL%
if %EXIT_CODE% equ 0 goto :done
if %EXIT_CODE% equ -1073741819 goto :done
echo.
echo [ERROR] Proxy exited with code %EXIT_CODE%

:done
exit

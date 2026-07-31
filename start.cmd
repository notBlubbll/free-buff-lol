@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

:: Detect port from config (same logic as UMANS-PROXY)
set "PORT=8080"
set "CONFIG_FILE=%~dp0.config\config.json"
if exist "%CONFIG_FILE%" (
    for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "$c=Get-Content '%CONFIG_FILE%' -Raw | ConvertFrom-Json; $l=$c.LISTEN_ADDR; if($l -match ':(?<p>\d+)$'){Write-Output $matches['p']}else{Write-Output '8080'}"`) do set "PORT=%%a"
)

title FREEBUFFProxy

echo ==================================================
echo  Freebuff2Opencode Proxy — http://localhost:%PORT%
echo ==================================================
echo.

set "BUN_PATH="

where bun.exe >nul 2>&1
if %ERRORLEVEL% equ 0 (
    for /f "delims=" %%b in ('where bun.exe') do (
        if not defined BUN_PATH set "BUN_PATH=%%~dpb"
    )
    goto :bunfound
)

where bun >nul 2>&1
if %ERRORLEVEL% equ 0 (
    for /f "delims=" %%b in ('where bun') do (
        if not defined BUN_PATH set "BUN_PATH=%%~dpb"
    )
    goto :bunfound
)

for %%d in (
    "%USERPROFILE%\.bun\bin"
    "%LOCALAPPDATA%\bun\bin"
    "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe"
    "%APPDATA%\bun\bin"
    "%APPDATA%\npm\node_modules\@oven\bun\bin"
    "%PROGRAMFILES%\bun\bin"
    "%PROGRAMFILES%\nodejs\node_modules\@oven\bun\bin"
    "%SYSTEMDRIVE%\.bun\bin"
    "%SYSTEMDRIVE%\Program Files\Bun\bin"
    "%SYSTEMDRIVE%\tools\bun"
) do (
    if exist "%%~d\bun.exe" (
        set "BUN_PATH=%%~d"
        goto :bunfound
    )
)

for /f "delims=" %%u in ('dir /b /ad "C:\Users" 2^>nul') do (
    if exist "C:\Users\%%u\.bun\bin\bun.exe" (
        set "BUN_PATH=C:\Users\%%u\.bun\bin"
        goto :bunfound
    )
    if exist "C:\Users\%%u\scoop\apps\bun\current\bun.exe" (
        set "BUN_PATH=C:\Users\%%u\scoop\apps\bun\current"
        goto :bunfound
    )
    if exist "C:\Users\%%u\AppData\Local\bun\bin\bun.exe" (
        set "BUN_PATH=C:\Users\%%u\AppData\Local\bun\bin"
        goto :bunfound
    )
)

:bunfound
if defined BUN_PATH (
    echo [INFO] Bun found at: %BUN_PATH%
    set "PATH=%BUN_PATH%;%PATH%"
)

echo [1/4] Cleaning up...
:: Kill only whatever is currently listening on the configured port.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo [2/4] Detecting runtime...
if defined BUN_PATH (
    echo [INFO] Runtime: Bun
    set "RUNTIME=bun"
    goto :start
)
where bun.exe >nul 2>&1
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
@if not defined OPENCODE_ATTACH timeout /t 5
exit

:start
echo [3/4] Installing dependencies...
if "%RUNTIME%"=="bun" (
    bun install
) else (
    call npm install --omit=dev
)
if exist "bun.lock" del /F /Q "bun.lock" >nul 2>&1
if exist "package-lock.json" del /F /Q "package-lock.json" >nul 2>&1

echo [4/4] Starting proxy...
echo.
echo ==================================================
echo  Proxy: http://127.0.0.1:%PORT%
echo  Dashboard: http://127.0.0.1:%PORT%/dashboard
echo ==================================================
echo.

if "%RUNTIME%"=="bun" (
    bun run index.js
) else (
    node index.js
)

set EXIT_CODE=%ERRORLEVEL%
if %EXIT_CODE% equ 0 goto :done
if %EXIT_CODE% equ -1073741819 goto :done
echo.
echo [ERROR] Proxy exited with code %EXIT_CODE%

:done
if not defined OPENCODE_ATTACH (
    echo.
    echo Proxy stopped.
    timeout /t 5 /nobreak >nul
)
exit

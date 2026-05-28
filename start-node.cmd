@echo off
setlocal enabledelayedexpansion

taskkill /F /FI "WINDOWTITLE eq Frebuff2Opencode Proxy - Node.js Mode" /T >nul 2>&1
timeout /t 1 /nobreak >nul

title Frebuff2Opencode Proxy - Node.js Mode
cd /d "%~dp0"

echo ==================================================
echo  Frebuff2Opencode Proxy - Node.js Mode
echo  Enforces Node.js (ignores Bun)
echo ==================================================
echo.

echo [1/3] Cleaning up...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8080') do (
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
echo  Proxy: http://localhost:8080
echo  Dashboard: http://localhost:8080/dashboard
echo ==================================================
echo.

set PROXY_RUNTIME=node
node proxy.js

set EXIT_CODE=%ERRORLEVEL%
if %EXIT_CODE% equ 0 goto :done
if %EXIT_CODE% equ -1073741819 goto :done
echo.
echo [ERROR] Proxy exited with code %EXIT_CODE%
pause
goto :done

:no_runtime
echo [ERROR] Node.js not found in PATH.
echo        Install Node: https://nodejs.org
pause

:done
echo.
echo Proxy stopped.
pause

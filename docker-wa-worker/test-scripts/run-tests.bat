@echo off
setlocal enabledelayedexpansion

echo ============================================================
echo    WhatsApp Worker - Full Test Suite
echo ============================================================
echo.

:: Configuration
set WEBHOOK_URL=http://host.docker.internal:3000/webhook
set IMAGE_NAME=whatsapp-worker-image:local
set SESSIONS_PATH=C:\wa-sessions

:: Colors (using ANSI)
set GREEN=[92m
set RED=[91m
set YELLOW=[93m
set CYAN=[96m
set RESET=[0m

echo %CYAN%[0] Preconditions Check%RESET%
echo.

:: Check Docker
docker info >nul 2>&1
if errorlevel 1 (
    echo %RED%FAIL: Docker is not running!%RESET%
    exit /b 1
)
echo %GREEN%PASS: Docker is running%RESET%

:: Create sessions directory
if not exist "%SESSIONS_PATH%" mkdir "%SESSIONS_PATH%"
echo %GREEN%PASS: Sessions directory ready%RESET%
echo.

:: ============================================================
echo %CYAN%[1] Build Test%RESET%
echo.

cd /d "%~dp0.."
echo Building image (no-cache)...
docker build --no-cache -t %IMAGE_NAME% . >nul 2>&1
if errorlevel 1 (
    echo %RED%FAIL: Build failed!%RESET%
    docker build --no-cache -t %IMAGE_NAME% .
    exit /b 1
)

docker image ls %IMAGE_NAME% --format "{{.Repository}}:{{.Tag}} - {{.Size}}"
echo %GREEN%PASS: Image built successfully%RESET%
echo.

:: ============================================================
echo %CYAN%[2] Start Test Webhook Server%RESET%
echo.

docker rm -f wa_test_webhook >nul 2>&1
docker build -t wa-test-webhook ./test-server >nul 2>&1
docker run -d --name wa_test_webhook -p 3000:3000 wa-test-webhook >nul 2>&1

timeout /t 2 >nul
curl -s http://localhost:3000/health >nul 2>&1
if errorlevel 1 (
    echo %RED%FAIL: Webhook server not responding%RESET%
    exit /b 1
)
echo %GREEN%PASS: Webhook server running at http://localhost:3000%RESET%
echo       Dashboard: http://localhost:3000/
echo       QR Viewer: http://localhost:3000/qr/123
echo.

:: ============================================================
echo %CYAN%[3] Run Worker Session 123 (no proxy)%RESET%
echo.

docker rm -f wa_session_123 >nul 2>&1
if not exist "%SESSIONS_PATH%\123" mkdir "%SESSIONS_PATH%\123"

docker run -d ^
  --name wa_session_123 ^
  -v %SESSIONS_PATH%\123:/app/sessions/123 ^
  -e SESSION_ID=123 ^
  -e WEBHOOK_URL=%WEBHOOK_URL% ^
  %IMAGE_NAME%

timeout /t 3 >nul

:: Check if container is running
docker ps --filter "name=wa_session_123" --format "{{.Status}}" | findstr "Up" >nul
if errorlevel 1 (
    echo %RED%FAIL: Container crashed!%RESET%
    echo Logs:
    docker logs wa_session_123
    exit /b 1
)
echo %GREEN%PASS: Container running%RESET%
echo.

echo %YELLOW%Waiting for QR_UPDATE (up to 30 seconds)...%RESET%
echo.

:: Wait for QR
set /a count=0
:wait_qr
timeout /t 2 >nul
set /a count+=2
curl -s http://localhost:3000/events/123 | findstr "QR_UPDATE" >nul
if not errorlevel 1 (
    echo %GREEN%PASS: QR_UPDATE received!%RESET%
    goto :qr_done
)
if %count% lss 30 goto :wait_qr
echo %RED%FAIL: No QR_UPDATE received within 30 seconds%RESET%

:qr_done
echo.

:: ============================================================
echo %CYAN%[4] Manual Test Instructions%RESET%
echo.
echo %YELLOW%Now you need to:%RESET%
echo   1. Open http://localhost:3000/qr/123 in your browser
echo   2. Scan the QR code with WhatsApp
echo   3. Wait for CONNECTED event in the webhook server logs
echo.
echo %YELLOW%To view live logs:%RESET%
echo   docker logs -f wa_session_123
echo.
echo %YELLOW%To view webhook events:%RESET%
echo   Open http://localhost:3000/events/123
echo.

:: ============================================================
echo %CYAN%[5] Additional Test Commands%RESET%
echo.
echo %YELLOW%Persistence Test (restart without losing session):%RESET%
echo   docker restart wa_session_123
echo.
echo %YELLOW%Second Session Test:%RESET%
echo   docker run -d --name wa_session_124 ^
echo     -v %SESSIONS_PATH%\124:/app/sessions/124 ^
echo     -e SESSION_ID=124 ^
echo     -e WEBHOOK_URL=%WEBHOOK_URL% ^
echo     %IMAGE_NAME%
echo.
echo %YELLOW%Proxy Test:%RESET%
echo   docker run -d --name wa_session_125 ^
echo     -v %SESSIONS_PATH%\125:/app/sessions/125 ^
echo     -e SESSION_ID=125 ^
echo     -e PROXY_URL=http://user:pass@ip:port ^
echo     -e WEBHOOK_URL=%WEBHOOK_URL% ^
echo     %IMAGE_NAME%
echo.
echo %YELLOW%Check Exit Code (after logout):%RESET%
echo   docker inspect wa_session_123 --format="{{.State.ExitCode}}"
echo.
echo %YELLOW%Resource Usage:%RESET%
echo   docker stats --no-stream wa_session_123
echo.

:: ============================================================
echo %CYAN%[6] Cleanup Commands%RESET%
echo.
echo   docker rm -f wa_session_123 wa_session_124 wa_session_125 wa_test_webhook
echo   rmdir /s /q %SESSIONS_PATH%
echo.

echo ============================================================
echo %GREEN%Test setup complete!%RESET%
echo ============================================================

pause


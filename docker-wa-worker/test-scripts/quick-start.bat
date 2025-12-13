@echo off
echo ============================================================
echo   Quick Start - WhatsApp Worker Test
echo ============================================================
echo.

set SESSIONS_PATH=C:\wa-sessions
set IMAGE_NAME=whatsapp-worker-image:local

:: Create directories
if not exist "%SESSIONS_PATH%\123" mkdir "%SESSIONS_PATH%\123"

:: Build images
echo Building worker image...
cd /d "%~dp0.."
docker build -t %IMAGE_NAME% .

echo Building webhook server...
docker build -t wa-test-webhook ./test-server

:: Cleanup old containers
docker rm -f wa_test_webhook wa_session_123 2>nul

:: Start webhook server
echo Starting webhook server...
docker run -d --name wa_test_webhook -p 3000:3000 wa-test-webhook

:: Wait for server
timeout /t 2 >nul

:: Start worker
echo Starting worker session 123...
docker run -d ^
  --name wa_session_123 ^
  -v %SESSIONS_PATH%\123:/app/sessions/123 ^
  -e SESSION_ID=123 ^
  -e WEBHOOK_URL=http://host.docker.internal:3000/webhook ^
  %IMAGE_NAME%

echo.
echo ============================================================
echo   READY!
echo ============================================================
echo.
echo   Dashboard: http://localhost:3000/
echo   QR Code:   http://localhost:3000/qr/123
echo.
echo   Worker logs: docker logs -f wa_session_123
echo   Webhook logs: docker logs -f wa_test_webhook
echo.

:: Open browser
start http://localhost:3000/qr/123

:: Show worker logs
docker logs -f wa_session_123


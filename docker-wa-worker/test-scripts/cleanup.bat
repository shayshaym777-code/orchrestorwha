@echo off
echo Cleaning up test containers and images...

:: Stop and remove containers
docker rm -f wa_session_123 2>nul
docker rm -f wa_session_124 2>nul
docker rm -f wa_session_125 2>nul
docker rm -f wa_test_webhook 2>nul

:: Remove test sessions (optional - uncomment if needed)
:: rmdir /s /q C:\wa-sessions

echo Done!
pause


#!/bin/bash
# בדיקות פריסה - PASS/FAIL

echo "=== בדיקות פריסה WhatsApp Orchestrator ==="
echo ""

# בדיקה 1: Health Check
echo "✅ בדיקה 1: Health Check"
HEALTH=$(curl -s http://localhost:3001/health)
if [[ "$HEALTH" == *"ok"* ]]; then
    echo "   PASS: $HEALTH"
else
    echo "   FAIL: $HEALTH"
fi
echo ""

# בדיקה 2: Redis
echo "✅ בדיקה 2: Redis"
REDIS=$(docker exec wa_redis redis-cli ping 2>/dev/null)
if [[ "$REDIS" == "PONG" ]]; then
    echo "   PASS: $REDIS"
else
    echo "   FAIL: $REDIS"
fi
echo ""

# בדיקה 3: קונטיינרים
echo "✅ בדיקה 3: קונטיינרים"
CONTAINERS=$(docker compose ps --format json 2>/dev/null | grep -c "Up" || echo "0")
if [ "$CONTAINERS" -ge 3 ]; then
    echo "   PASS: $CONTAINERS קונטיינרים רצים"
else
    echo "   FAIL: רק $CONTAINERS קונטיינרים רצים"
fi
echo ""

# בדיקה 4: Workers שולחים QR
echo "✅ בדיקה 4: Workers שולחים QR"
QR_COUNT=$(docker logs wa_worker_1 --tail 10 2>&1 | grep -c "QR_UPDATE" || echo "0")
if [ "$QR_COUNT" -gt 0 ]; then
    echo "   PASS: Worker 1 שולח QR updates"
else
    echo "   FAIL: Worker 1 לא שולח QR"
fi
echo ""

# בדיקה 5: API סשנים
echo "✅ בדיקה 5: API סשנים"
API_KEY=$(grep "^API_KEY=" .env 2>/dev/null | cut -d'=' -f2 | head -1)
if [ -z "$API_KEY" ]; then
    echo "   SKIP: אין API_KEY ב-.env"
else
    SESSIONS=$(curl -s -H "X-API-KEY: $API_KEY" http://localhost:3001/api/v1/dashboard/sessions 2>/dev/null | grep -c "sessionId" || echo "0")
    SESSIONS_NUM=$(echo "$SESSIONS" | tr -d ' ')
    if [ "$SESSIONS_NUM" -gt 0 ] 2>/dev/null; then
        echo "   PASS: $SESSIONS_NUM סשנים נמצאו"
    else
        echo "   FAIL: אין סשנים או שגיאת API"
    fi
fi
echo ""

# בדיקה 6: דף סריקה
echo "✅ בדיקה 6: דף סריקה"
SCAN=$(curl -s http://localhost:3001/scan 2>/dev/null | head -1)
if [[ "$SCAN" == *"<!DOCTYPE"* ]]; then
    echo "   PASS: דף סריקה נטען"
else
    echo "   FAIL: דף סריקה לא נטען"
fi
echo ""

# בדיקה 7: גישה חיצונית
echo "✅ בדיקה 7: גישה חיצונית"
EXTERNAL_IP=$(curl -s ifconfig.me 2>/dev/null || echo "לא ניתן לקבל IP")
EXTERNAL_HEALTH=$(curl -s http://$EXTERNAL_IP:3001/health 2>/dev/null)
if [[ "$EXTERNAL_HEALTH" == *"ok"* ]]; then
    echo "   PASS: גישה חיצונית עובדת ($EXTERNAL_IP:3001)"
else
    echo "   FAIL: גישה חיצונית לא עובדת (firewall?)"
fi
echo ""

echo "=== סיום בדיקות ==="

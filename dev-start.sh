#!/bin/bash

# ReturnEase dev starter - ngrok + shopify

cd /Users/kadir/Documents/shopify/returnease

# 1. Kill existing processes
pkill -f "shopify app dev" 2>/dev/null
pkill -f "ngrok" 2>/dev/null
pkill -f "cloudflared" 2>/dev/null
sleep 2

# 2. Start Remix dev server in background (port 3000)
SHOPIFY_FLAG_SKIP_TUNNEL=true npx remix vite:dev --port 3000 &
REMIX_PID=$!
echo "Remix PID: $REMIX_PID"
sleep 8

# 3. Start ngrok tunnel
ngrok http 3000 --log=stdout --log-level=info &
NGROK_PID=$!
sleep 5

# 4. Get ngrok URL
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tunnels'][0]['public_url'])" 2>/dev/null)
echo ""
echo "✅ ngrok URL: $NGROK_URL"
echo ""
echo "Şimdi bu komutu çalıştır:"
echo "npm run dev -- --tunnel-url ${NGROK_URL}:443"
echo ""

wait

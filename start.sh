#!/bin/bash
# Teams HRIS — Start Script
# วิธีใช้: เปิด Terminal → cd /Users/padungdech/COWORK/admin-web → bash start.sh

cd "$(dirname "$0")"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Teams HRIS Backend"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Check Node.js ──
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js not found."
  echo "Please install from https://nodejs.org"
  exit 1
fi
echo "Node.js: $(node --version)"

# ── Install dependencies if needed ──
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# ── Kill any existing server on port 3001 ──
lsof -ti:3001 | xargs kill -9 2>/dev/null

# ── Start server ──
echo ""
echo "Starting backend server on port 3001..."
echo "Open hris.html in your browser to use the app."
echo "(Press Ctrl+C to stop)"
echo ""
node server.js

#!/bin/bash
cd "$(dirname "$0")"

echo "[1/5] Removing lock files..."
rm -f .git/index.lock .git/COMMIT_EDITMSG.lock

echo "[2/5] Setting up git..."
git init 2>/dev/null || true
git config user.email "padungdech.w@gmail.com"
git config user.name "DECH"
git checkout -b main 2>/dev/null || git checkout main 2>/dev/null || true

echo "[3/5] Staging files..."
git add hris.html .gitignore package.json server.js config.js start.sh 2>/dev/null || git add hris.html .gitignore config.js

echo "[4/5] Committing..."
if git diff --cached --quiet; then
  echo "Nothing to commit."
else
  git commit -m "Initial commit: Teams HRIS"
fi

echo "[5/5] Pushing to GitHub..."
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/padubgdech/teams-hris.git
git push -u origin main

echo ""
echo "Done: https://github.com/padubgdech/teams-hris"
echo "Press Enter to close..."
read

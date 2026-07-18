#!/bin/bash
cd ~/COWORK/admin-web
git add hris.html .gitignore
git commit -m "Teams HRIS"
git push -u origin main
echo "Done!"
read -p "Press Enter to close..."

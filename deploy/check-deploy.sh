#!/bin/bash
# Polls origin/master and triggers deploy if changed.
# Called by swimreader-deploy.timer every 60 seconds.
set -e
cd /home/JY/SwimReader

git fetch origin master --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)

if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0
fi

echo "[Deploy] Changes detected: $LOCAL -> $REMOTE"
exec /home/JY/SwimReader/deploy/deploy.sh

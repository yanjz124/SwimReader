#!/bin/bash
# Smart deploy: only restart services when backend code changes.
# Frontend (wwwroot) changes take effect immediately via static file serving.
set -e
cd /home/JY/SwimReader

PREV_HEAD=$(git rev-parse HEAD)
git pull origin master --ff-only

NEW_HEAD=$(git rev-parse HEAD)
if [ "$PREV_HEAD" = "$NEW_HEAD" ]; then
    echo "[Deploy] Already up to date"
    exit 0
fi

echo "[Deploy] Updated $PREV_HEAD -> $NEW_HEAD"
CHANGED=$(git diff --name-only "$PREV_HEAD" "$NEW_HEAD")

# Detect backend changes per project
SFDPS_RESTART=false
STDDS_RESTART=false

# SfdpsERAM backend: any .cs or .csproj under tools/SfdpsERAM/
if echo "$CHANGED" | grep -qE '^tools/SfdpsERAM/.*\.(cs|csproj)$'; then
    SFDPS_RESTART=true
fi

# SwimReader.Server backend: any .cs or .csproj under src/
if echo "$CHANGED" | grep -qE '^src/.*\.(cs|csproj)$'; then
    STDDS_RESTART=true
fi

# Solution-level changes affect both
if echo "$CHANGED" | grep -qE '^(SwimReader\.sln|Directory\..*)$'; then
    SFDPS_RESTART=true
    STDDS_RESTART=true
fi

# Build only what needs restarting
if [ "$SFDPS_RESTART" = true ]; then
    echo "[Deploy] Building SfdpsERAM..."
    /home/JY/.dotnet/dotnet build tools/SfdpsERAM/SfdpsERAM.csproj -c Release --nologo -v quiet
fi

if [ "$STDDS_RESTART" = true ]; then
    echo "[Deploy] Building SwimReader.Server..."
    /home/JY/.dotnet/dotnet build src/SwimReader.Server/SwimReader.Server.csproj -c Release --nologo -v quiet
fi

# Restart only services with backend changes
if [ "$SFDPS_RESTART" = true ]; then
    echo "[Deploy] Restarting sfdps-eram..."
    sudo systemctl restart sfdps-eram
fi

if [ "$STDDS_RESTART" = true ]; then
    echo "[Deploy] Restarting swimreader-stdds..."
    sudo systemctl restart swimreader-stdds
fi

if [ "$SFDPS_RESTART" = false ] && [ "$STDDS_RESTART" = false ]; then
    echo "[Deploy] Frontend-only changes — no restart needed, changes are live"
else
    echo "[Deploy] Deployment complete"
fi

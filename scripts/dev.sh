#!/usr/bin/env bash
# Rebuild both frames and the service, then make OpenChamber load the new copy.
#
# A folder install serves the files from this checkout, but the guest keeps the
# frames it already loaded, so a pause/enable is what actually reloads them. A
# git install runs from OpenChamber's own copy: a rebuild here changes nothing
# until the version is bumped, pushed, and the update is applied in Settings.
set -euo pipefail
cd "$(dirname "$0")/.."

bun run build >/dev/null
port=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/openchamber/settings.json')))['desktopLocalPort'])" 2>/dev/null || true)
if [ -z "${port:-}" ]; then
  echo 'dev: built, but there is no OpenChamber desktop port in settings.json to reload through' >&2
  exit 1
fi

source_kind=$(curl -s --max-time 2 "http://127.0.0.1:${port}/api/guests" |
  node -e 'let raw="";process.stdin.on("data",(d)=>raw+=d).on("end",()=>{try{const g=JSON.parse(raw).guests.find((x)=>x.id==="token-meter");console.log(g?g.source:"none")}catch{console.log("none")}})' 2>/dev/null || echo none)
if [ "$source_kind" = git ]; then
  echo 'dev: the extension is installed from git, so this build is not what OpenChamber loads.' >&2
  echo '     Reinstall the folder (Settings → Extensions) to iterate, or bump + push + update.' >&2
  exit 2
fi

for state in false true; do
  curl -s -o /dev/null -X PUT "http://127.0.0.1:${port}/api/guests/token-meter/enabled" \
    -H 'content-type: application/json' -d "{\"enabled\":${state}}"
  sleep 0.5
done
echo "dev: rebuilt and reloaded on 127.0.0.1:${port} — reopen the panel to see it"

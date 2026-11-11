#!/usr/bin/env bash
# The facts a `status` report needs, in one screen: no work, no guesses.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
last=$(git describe --tags --abbrev=0 2>/dev/null || echo 'none')
last_hash=$(git rev-list -n1 "$last" 2>/dev/null | cut -c1-7 || echo '-')
since=$(git rev-list --count "${last}..HEAD" 2>/dev/null || echo '?')
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo '?')
tree=$([ -z "$(git status --porcelain)" ] && echo clean || echo dirty)
head_hash=$(git rev-list -n1 HEAD | cut -c1-7)

port=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/openchamber/settings.json')))['desktopLocalPort'])" 2>/dev/null || true)
install='not installed'
if [ -n "${port:-}" ]; then
  install=$(curl -s --max-time 2 "http://127.0.0.1:${port}/api/guests" 2>/dev/null |
    node -e 'let raw="";process.stdin.on("data",(d)=>raw+=d).on("end",()=>{try{const g=JSON.parse(raw).guests.find((x)=>x.id==="token-meter");console.log(g?`${g.source} · v${g.version} · ${g.path}`:"not installed")}catch{console.log("not installed")}})' 2>/dev/null || echo 'not installed')
fi
app=$(defaults read /Applications/OpenChamber.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo '?')

printf 'version      %s\n' "$version"
printf 'head         %s (%s tree)\n' "$head_hash" "$tree"
printf 'stable       %s %s, %s commit(s) since\n' "$last" "$last_hash" "$since"
printf 'remote       %s commit(s) ahead of origin/main\n' "$ahead"
printf 'install      %s\n' "$install"
printf 'openchamber  %s  ·  node %s\n' "$app" "$(node -v)"
printf 'next         %s\n' "$(bash scripts/next-version.sh)"

#!/usr/bin/env bash
# Host only: dependencies must already be installed. Do not run in sandbox.
set -u
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo" || exit 1
mkdir -p "$repo/tmp" || exit 1
work=$(mktemp -d "$repo/tmp/e2e-host.XXXXXX") || exit 1
export BRIDGE_OUT="$work"
export BRIDGE_PORT="${BRIDGE_PORT:-$(node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close();});')}"
pid=''
passed=0
failed=0
reason=''
session=''
token=''
url="http://127.0.0.1:$BRIDGE_PORT"
cleanup() {
  if [ -n "$pid" ]; then
    kill -TERM "$pid" 2>/dev/null || true
    for ((attempt=0; attempt<50; attempt++)); do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
    wait "$pid" 2>/dev/null || true
    pid=''
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
bin/start.sh > "$work/server.log" 2>&1 &
pid=$!
for ((i=0; i<100; i++)); do
  if [ -s "$work/bridge.json" ]; then
    token=$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).token)' "$work/bridge.json" 2>/dev/null) || token=''
    if [ -n "$token" ] && curl --noproxy '*' -fsS --max-time 1 -H "Authorization: Bearer $token" "$url/health" > /dev/null 2>&1; then break; fi
  fi
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.1
done

call() {
  local method=$1 endpoint=$2 body=$3 expected=${4:-200} code
  local args=(--noproxy '*' -sS --max-time 150 -X "$method" -H "Authorization: Bearer $token" -o "$work/response.json" -w '%{http_code}')
  if [ "$method" = POST ]; then args+=(-H 'Content-Type: application/json' --data "$body"); fi
  code=$(curl "${args[@]}" "$url$endpoint" 2> "$work/curl-error.txt") || { reason="curl failed for $endpoint"; return 1; }
  if [ "$code" != "$expected" ]; then reason="$endpoint HTTP $code, expected $expected"; return 1; fi
}
field() {
  node -e 'const fs=require("node:fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(typeof b[process.argv[2]]!=="string")process.exit(1); console.log(b[process.argv[2]]);' "$work/response.json" "$1"
}
check() {
  node --input-type=module - "$work/response.json" "$1" "$work" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const step = process.argv[3];
const root = fs.realpathSync(process.argv[4]);
const file = (p, min = 0) => { assert.equal(typeof p, 'string'); assert.ok(fs.realpathSync(p).startsWith(root + path.sep)); assert.ok(fs.statSync(p).size > min); };
switch (step) {
  case 'health': assert.equal(b.ok, true); assert.equal(b.sessions, 0); break;
  case 'session': assert.match(b.session, /^[a-f\d-]{36}$/); break;
  case 'mobile': assert.equal(b.result.width, 390); assert.equal(b.result.height, 844); assert.equal(b.result.scale, 2); assert.ok(b.result.touch > 0); break;
  case 'goto': assert.equal(b.status, 200); assert.match(b.finalUrl, /^https:\/\/example\.com\/?/); assert.match(b.title, /Example Domain/); break;
  case 'screenshot': file(b.path, 1024); break;
  case 'scroll': assert.equal(typeof b.scrollY, 'number'); assert.ok(Number.isFinite(b.scrollY)); assert.ok(b.scrollY > 0); break;
  case 'frames': assert.equal(b.paths.length, 5); b.paths.forEach(p => file(p, 1024)); file(b.contactSheet, 1024); break;
  case 'html': file(b.htmlPath); file(b.resourcesPath); assert.match(fs.readFileSync(b.htmlPath, 'utf8'), /Example Domain/); assert.ok(Array.isArray(JSON.parse(fs.readFileSync(b.resourcesPath, 'utf8')))); break;
  case 'denied': assert.equal(b.ok, false); break;
  case 'close': assert.equal(b.closed, true); break;
  default: assert.fail('Unknown check');
}
JS
  local code=$?
  if [ "$code" -ne 0 ]; then reason="$1 response or artifact check failed"; return 1; fi
}
health() { call GET /health '' && check health; }
new_session() {
  call POST /session/new '{"viewport":"mobile390"}' && check session || return 1
  session=$(field session) || { reason='missing session'; return 1; }
  # Navigate to a page with a viewport meta tag before reading mobile dimensions.
  goto_example || return 1
  call POST /eval "{\"session\":\"$session\",\"expression\":\"({width:innerWidth,height:innerHeight,scale:devicePixelRatio,touch:navigator.maxTouchPoints})\"}" && check mobile
}
goto_example() { call POST /goto "{\"session\":\"$session\",\"url\":\"https://example.com\"}" && check goto; }
screenshot() { call POST /screenshot "{\"session\":\"$session\"}" && check screenshot; }
scroll() {
  # Give the reference page enough height for both wheel speeds to be visible.
  call POST /eval "{\"session\":\"$session\",\"expression\":\"document.body.style.minHeight='5000px'; true\"}" || return 1
  call POST /scroll "{\"session\":\"$session\",\"mode\":\"wheel\",\"deltaY\":600,\"steps\":6,\"durationMs\":120}" && check scroll || return 1
  call POST /scroll "{\"session\":\"$session\",\"mode\":\"wheel\",\"deltaY\":600,\"steps\":30,\"durationMs\":1200}" && check scroll
}
frames() { call POST /frames "{\"session\":\"$session\",\"everyMs\":100,\"count\":5}" && check frames; }
html() { call POST /html "{\"session\":\"$session\"}" && check html; }
deny_file() { call POST /goto "{\"session\":\"$session\",\"url\":\"file:///etc/hosts\"}" 403 && check denied; }
deny_private() { call POST /goto "{\"session\":\"$session\",\"url\":\"http://192.168.1.1\"}" 403 && check denied; }
close_session() { call POST /close "{\"session\":\"$session\"}" && check close; }
run() {
  local label=$1 action=$2
  reason='step failed'
  if "$action" > "$work/check-output.txt" 2>&1; then
    passed=$((passed + 1)); printf 'PASS %s\n' "$label"
  else
    failed=$((failed + 1)); printf 'FAIL %s: %s\n' "$label" "$reason"
  fi
}
run health health
run mobile390 new_session
run goto-example goto_example
run screenshot screenshot
run wheel-two-speeds scroll
run frames-contact-sheet frames
run html-resources html
run reject-file deny_file
run reject-private-ip deny_private
run close close_session
cleanup
printf 'E2E: %s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]

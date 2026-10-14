# browse-bridge

A Chromium HTTP service on the host machine that lets a sandboxed agent open reference websites, watch them scroll, take screenshots, sample frames and study interactions. **It is meant for agents on the same machine only; do not expose it.** The service listens on `127.0.0.1` only, and every request, including health, needs a Bearer token.

## Install and start

The host needs Node.js 22 or newer.

```sh
npm ci
npx playwright install chromium
mkdir -p "$PWD/tmp/output"
BRIDGE_OUT="$PWD/tmp/output" bin/start.sh
# optional: BRIDGE_PORT=7789 (default 7788). The output directory must already exist and be an absolute path.
```

`bin/start.sh` generates a token with `openssl rand -hex 24`, writes the connection details to `bridge.json` in the output directory (mode 600), then starts the service. Every restart rotates the token. To run `node src/server.mjs` directly, set `BRIDGE_OUT` and `BRIDGE_TOKEN` yourself (`BRIDGE_PORT` is optional). Playwright is imported only when the first session is created, so the health check and the pure-function tests need no browser.

## Endpoints

Run these in another terminal. Let the agent read the connection details from `bridge.json`, and never commit the token to a repository. One curl example per endpoint:

```sh
export BRIDGE_OUT="$PWD/tmp/output"
export URL=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.env.BRIDGE_OUT+"/bridge.json","utf8")).url)')
export TOKEN=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.env.BRIDGE_OUT+"/bridge.json","utf8")).token)')

# GET /health
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" "$URL/health"

# POST /session/new; desktop = 1440×900, mobile390 = 390×844 / 2x / touch
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data '{"viewport":"mobile390","reducedMotion":true,"record":true}' "$URL/session/new"
# Use the session returned above. Every new session is a fresh, non-persistent context.
export SESSION='<session UUID>'

# POST /goto; http://localhost:3000 through :3010 are allowed too
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"session\":\"$SESSION\",\"url\":\"https://example.com\",\"waitUntil\":\"load\"}" "$URL/goto"

# POST /scroll; wheel scrolls in steps, smooth uses scrollBy, to uses scrollTo
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"session\":\"$SESSION\",\"mode\":\"wheel\",\"deltaY\":1000,\"steps\":50,\"durationMs\":2000}" "$URL/scroll"
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"session\":\"$SESSION\",\"mode\":\"smooth\",\"deltaY\":500,\"durationMs\":1000}" "$URL/scroll"
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"session\":\"$SESSION\",\"mode\":\"to\",\"y\":0}" "$URL/scroll"

# POST /screenshot; returns an absolute PNG path on the host
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"session\":\"$SESSION\",\"fullPage\":true}" "$URL/screenshot"

# POST /frames; returns viewport screenshot paths plus an HTML grid contact sheet (contactSheet); no ffmpeg needed
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"session\":\"$SESSION\",\"everyMs\":100,\"count\":5}" "$URL/frames"

# POST /html; saves the current DOM and the session's cumulative list of resource URLs and types
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"session\":\"$SESSION\"}" "$URL/html"

# POST /eval; runs in the page; expressions up to 4,000 characters, JSON results up to 200 KiB
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"session\":\"$SESSION\",\"expression\":\"({title:document.title,scrollY:window.scrollY})\"}" "$URL/eval"

# POST /close; closes the context and finishes the video; returns the video path when record=true
curl --noproxy '*' -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"session\":\"$SESSION\"}" "$URL/close"
```

## Limits

- A custom viewport looks like `{"width":640,"height":1000}`: width 320–2560, height 480–2000.
- At most three sessions, including ones being created at the same moment; beyond that the service returns 429.
- A session closes after ten idle minutes (detection can lag by about thirty seconds); a request in progress does not count as idle. Operations on one session run one at a time, in arrival order.
- `wheel` defaults to one step with no wait, and `smooth` to no wait; steps 1–400, durationMs 0–20000. For `/frames`, everyMs is 50–2000 and count 1–60; frames are sampled at the target interval, and slow screenshots can lower the actual rate.
- Errors: invalid JSON, types, ranges, unknown parameters or sessions → 400; missing or wrong token → 401; disallowed URL → 403; unknown endpoint → 404; browser failure → 500. Navigation waits at most 45 seconds.

## Network policy

Subresources may come from public HTTP/HTTPS, the allowed local dev ports, and data/blob URLs. Top-level navigation is limited to public HTTPS, the local HTTP dev ports and about:blank; `::1` and `127.0.0.1` follow the same port rules. URLs with credentials, private or reserved addresses, and private domains such as `.local`, `.internal`, `.lan` and `.home` are refused. The service intercepts main-frame, subframe and subresource requests, blocks service workers, cancels downloads, and checks what each domain resolves to.

Two limits matter if a page may be hostile:

- **Redirect hops are not checked against the top-level rules.** Playwright does not route redirects, so the top-level rules apply to the initial URL and to the final URL, not to the hops in between; a redirect chain can pass through public plain-HTTP URLs. Every connection still goes through the proxy's address checks.
- **WebSocket blocking is best effort.** WebSockets opened through the page's WebSocket API are intercepted and closed by a page-level hook, which a hostile page can get around, and workers are not covered. The proxy still limits which addresses can be reached.

At startup the host also opens an authenticated, temporary loopback HTTP/CONNECT proxy, so Chromium connects to the IPs the service checked and pinned. The proxy has its own random credentials, separate from the service token: Playwright can present proxy credentials to any site that asks for HTTP authentication, so they are not secret from the sites the browser visits. DNS answers that mix public and private addresses are refused, so the browser cannot re-resolve its way around the check, and the dev ports are forced through the proxy as well. The proxy closes with the browser; QUIC and direct WebRTC UDP are disabled. Route checks and final-address checks constrain top-level navigation, and the proxy blocks private addresses at the connection layer. The injectable `launchBrowser` exists for tests: real use should go through the host entry point that launches the browser directly, which is what applies the proxy configuration. These Chromium behaviours have not all been verified with a real browser; the host check below covers what it lists.

## Output and logs

Output goes only to `BRIDGE_OUT/<service-generated UUID>/`; clients cannot choose file names. The log is `BRIDGE_OUT/bridge-log.jsonl`: one JSON line per request with time, endpoint, session, URL and HTTP status, never the auth token. The output directory should belong to the host user alone, because the log records request URLs, including the query parameters of the pages visited. `/html` saves the current DOM; the resource list records URLs and types without downloading the files. There is no CORS allowance.

## Tests

Sandbox tests need no installed dependencies, launch no Chromium and open no sockets; they use a fake browser with real Node HTTP request/response objects and in-memory streams:

```sh
node --test test/
node --test test/policy.test.mjs
```

The host end-to-end check uses a real browser. It prints PASS/FAIL for ten steps, ends with `E2E: 10 passed, 0 failed`, and exits non-zero on any failure. The script creates its own output directory under the repository's `tmp/`, starts the service in the background, shuts it down at the end, and keeps the screenshots and log for inspection:

```sh
npm ci && npx playwright install chromium && bash test/e2e-host.sh
```

The lockfile was written offline from exact-version npm tarball URLs. On macOS with Node 24, `npm ci` with it, the 142 sandbox tests and the ten-step host check passed.

## License

MIT (see `LICENSE`).

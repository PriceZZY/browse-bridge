import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { statSync, realpathSync } from 'node:fs';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { isAllowedTopLevel, isAllowedSubresource, validateBody } from './policy.mjs';
import { createEgressProxy, resolveDestination } from './egress.mjs';

const endpoints = new Set(['/session/new', '/goto', '/scroll', '/screenshot', '/frames', '/html', '/eval', '/close']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (status, message) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest();

function outputDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('BRIDGE_OUT must be an existing absolute directory');
  if (!statSync(value).isDirectory()) throw new Error('BRIDGE_OUT must be a directory');
  return realpathSync(value);
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw failure(400, 'Content-Type must be application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 32 * 1024) {
      req.resume();
      throw failure(400, 'Request body exceeds 32 KB');
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure(400, 'Invalid JSON'); }
}

async function publicResolution(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  await resolveDestination(url);
  return true;
}

async function launchHostBrowser(token) {
  const m = await import('playwright');
  const proxy = createEgressProxy(token);
  try {
    await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const browser = await m.chromium.launch({ headless: true,
      proxy: { server: `http://127.0.0.1:${proxy.address().port}`, username: 'bridge', password: token, bypass: '<-loopback>' },
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
    const close = browser.close.bind(browser);
    browser.close = async () => { try { await close(); } finally { await proxy.shutdown(); } };
    browser.on('disconnected', () => { void proxy.shutdown(); });
    return browser;
  } catch (error) { await proxy.shutdown(); throw error; }
}

export function createServer({ launchBrowser, outDir, token }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('BRIDGE_TOKEN is required');
  const root = outputDirectory(outDir);
  if (typeof launchBrowser !== 'function') throw new Error('launchBrowser is required');
  const expectedToken = digest(`Bearer ${token}`);
  const sessions = new Map();
  let browserPromise;
  let shuttingDown = false;
  let logQueue = Promise.resolve();
  const browser = () => browserPromise ||= Promise.resolve().then(launchBrowser).catch(error => {
    browserPromise = undefined;
    throw error;
  });
  const generatedPath = (session, suffix) => path.join(session.dir, `${randomUUID()}.${suffix}`);
  const inside = (dir, file) => path.isAbsolute(file) && file.startsWith(`${dir}${path.sep}`);

  async function closeSession(session) {
    let video;
    try {
      const recording = session.record ? session.page?.video() : undefined;
      await session.context?.close();
      if (recording) {
        video = await recording.path();
        if (!inside(session.dir, video)) throw failure(500, 'Invalid video output path');
      }
      return { closed: true, ...(video ? { video } : {}) };
    } finally { sessions.delete(session.id); }
  }

  async function configureContext(context, session) {
    await context.route('**/*', async route => {
      const request = route.request();
      let main = false;
      try { main = request.isNavigationRequest() && request.frame().parentFrame() === null; } catch { /* worker request */ }
      const verdict = (main ? isAllowedTopLevel : isAllowedSubresource)(request.url());
      let permitted = false;
      try { permitted = verdict.ok && await publicResolution(request.url()); } catch { /* fail closed */ }
      if (!permitted) {
        if (main) session.blockedNavigation = true;
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    // JS evaluation must not bypass the HTTP resource policy with WebSockets.
    await context.routeWebSocket('**/*', socket => socket.close());
    context.on('requestfinished', request => {
      session.resources.set(`${request.resourceType()}\n${request.url()}`, { url: request.url(), type: request.resourceType() });
    });
    context.on('page', page => {
      page.on('download', download => { void download.cancel().catch(() => {}); });
      page.on('framenavigated', frame => {
        if (!frame.parentFrame() && !isAllowedTopLevel(frame.url()).ok) {
          session.blockedNavigation = true;
          void page.goto('about:blank').catch(() => {});
        }
      });
    });
  }

  async function dispatch(endpoint, body) {
    if (endpoint === '/session/new') {
      if (shuttingDown) throw failure(503, 'Server is shutting down');
      if (sessions.size >= 3) throw failure(429, 'Maximum of 3 sessions');
      const id = randomUUID();
      const session = { id, dir: path.join(root, id), lastUsed: Date.now(), active: 1,
        resources: new Map(), queue: Promise.resolve(), record: body.record === true };
      sessions.set(id, session); // Reserve before asynchronous launch to enforce the limit.
      try {
        await mkdir(session.dir, { mode: 0o700 });
        const viewport = body.viewport === 'desktop' ? { width: 1440, height: 900 } :
          body.viewport === 'mobile390' ? { width: 390, height: 844 } : body.viewport;
        session.context = await (await browser()).newContext({ viewport, acceptDownloads: false, serviceWorkers: 'block',
          ...(body.viewport === 'mobile390' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
          ...(body.reducedMotion ? { reducedMotion: 'reduce' } : {}),
          ...(body.record ? { recordVideo: { dir: session.dir } } : {}) });
        await configureContext(session.context, session);
        session.page = await session.context.newPage();
        session.active = 0;
        session.lastUsed = Date.now();
        return { session: id };
      } catch (error) {
        await closeSession(session).catch(() => {});
        throw error;
      }
    }
    const session = sessions.get(body.session);
    if (!session?.page) throw failure(400, 'Unknown or initializing session');
    session.lastUsed = Date.now();
    session.active++;
    const operation = session.queue.then(async () => {
      if (!sessions.has(session.id)) throw failure(400, 'Session is closed');
      const page = session.page;
      switch (endpoint) {
        case '/goto': {
          const verdict = isAllowedTopLevel(body.url);
          if (!verdict.ok) throw failure(403, verdict.reason);
          session.blockedNavigation = false;
          let response;
          try { response = await page.goto(body.url, { waitUntil: body.waitUntil || 'load', timeout: 45000 }); }
          catch (error) {
            if (session.blockedNavigation) {
              await page.goto('about:blank');
              throw failure(403, 'Navigation blocked by URL policy');
            }
            throw error;
          }
          if (session.blockedNavigation || !isAllowedTopLevel(page.url()).ok) {
            await page.goto('about:blank');
            throw failure(403, 'Final URL is forbidden');
          }
          return { status: response?.status() ?? null, finalUrl: page.url(), title: await page.title() };
        }
        case '/scroll': {
          if (body.mode === 'wheel') {
            const steps = body.steps ?? 1;
            const duration = body.durationMs ?? 0;
            const start = Date.now();
            for (let i = 0; i < steps; i++) {
              await page.mouse.wheel(0, body.deltaY / steps);
              await delay(Math.max(0, start + duration * (i + 1) / steps - Date.now()));
            }
          } else if (body.mode === 'smooth') {
            await page.evaluate(deltaY => window.scrollBy({ top: deltaY, behavior: 'smooth' }), body.deltaY);
            await delay(body.durationMs ?? 0);
          } else await page.evaluate(y => window.scrollTo(0, y), body.y);
          return { scrollY: await page.evaluate(() => window.scrollY) };
        }
        case '/screenshot': {
          const file = generatedPath(session, 'png');
          await page.screenshot({ path: file, type: 'png', fullPage: body.fullPage ?? false });
          return { path: file };
        }
        case '/frames': {
          const paths = [];
          const start = Date.now();
          for (let i = 0; i < body.count; i++) {
            await delay(Math.max(0, start + body.everyMs * (i + 1) - Date.now()));
            const file = generatedPath(session, 'png');
            await page.screenshot({ path: file, type: 'png', fullPage: false });
            paths.push(file);
          }
          const images = await Promise.all(paths.map(async file => (await readFile(file)).toString('base64')));
          const sheetContext = await (await browser()).newContext({ viewport: { width: 1020, height: 900 },
            acceptDownloads: false, javaScriptEnabled: false, serviceWorkers: 'block' });
          const contactSheet = generatedPath(session, 'png');
          try {
            const sheet = await sheetContext.newPage();
            await sheet.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:12px;background:#eee;display:grid;grid-template-columns:repeat(3,320px);gap:12px}figure{margin:0}img{width:320px;display:block}figcaption{font:14px sans-serif;padding:5px}</style>${images.map((img, i) => `<figure><img src="data:image/png;base64,${img}"><figcaption>Frame ${i + 1}</figcaption></figure>`).join('')}`);
            await sheet.evaluate(() => Promise.all(Array.from(document.images, img => img.decode())));
            await sheet.screenshot({ path: contactSheet, type: 'png', fullPage: true });
          } finally { await sheetContext.close(); }
          return { paths, contactSheet };
        }
        case '/html': {
          const htmlPath = generatedPath(session, 'html');
          const resourcesPath = generatedPath(session, 'json');
          await writeFile(htmlPath, await page.content(), { mode: 0o600 });
          await writeFile(resourcesPath, JSON.stringify([...session.resources.values()], null, 2), { mode: 0o600 });
          return { htmlPath, resourcesPath };
        }
        case '/eval': {
          const result = await page.evaluate(body.expression);
          let serialized;
          try { serialized = JSON.stringify(result); } catch { throw failure(400, 'Result is not JSON serializable'); }
          if (serialized === undefined) throw failure(400, 'Result is not JSON serializable');
          if (Buffer.byteLength(serialized, 'utf8') > 200 * 1024) throw failure(400, 'Result exceeds 200 KB');
          return { result: JSON.parse(serialized) };
        }
        case '/close': return closeSession(session);
      }
    });
    session.queue = operation.catch(() => {});
    try { return await operation; }
    finally { session.active--; session.lastUsed = Date.now(); }
  }

  const server = http.createServer(async (req, res) => {
    let endpoint = '';
    let body;
    let logSession = null;
    res.on('finish', () => {
      const entry = { time: new Date().toISOString(), endpoint, session: logSession ?? body?.session ?? null,
        url: body?.url ?? null, status: res.statusCode };
      logQueue = logQueue.then(() => appendFile(path.join(root, 'bridge-log.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 }))
        .catch(error => { console.error(`Request log write failed: ${error.code || 'unknown'}`); });
    });
    try {
      endpoint = new URL(req.url, 'http://127.0.0.1').pathname;
      if (!timingSafeEqual(digest(req.headers.authorization || ''), expectedToken)) throw failure(401, 'Unauthorized');
      let result;
      if (endpoint === '/health') {
        if (req.method !== 'GET') throw failure(400, 'GET required');
        result = { ok: true, sessions: sessions.size };
      } else {
        if (!endpoints.has(endpoint)) throw failure(404, 'Unknown endpoint');
        if (req.method !== 'POST') throw failure(400, 'POST required');
        body = await jsonBody(req);
        const validation = validateBody(endpoint, body);
        if (!validation.ok) throw failure(400, validation.reason);
        result = await dispatch(endpoint, body);
        logSession = result?.session ?? null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error.status || 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, reason: error.status ? error.message : 'Browser operation failed' }));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const idleTimer = setInterval(() => {
    for (const session of sessions.values()) {
      if (!session.active && Date.now() - session.lastUsed >= 10 * 60 * 1000) {
        session.active++;
        session.queue = session.queue.then(() => closeSession(session)).catch(() => {});
      }
    }
  }, 30000);
  idleTimer.unref();
  server.on('close', () => clearInterval(idleTimer));
  server.shutdown = async () => {
    shuttingDown = true;
    clearInterval(idleTimer);
    const stopped = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    server.closeIdleConnections();
    await stopped;
    await Promise.all([...sessions.values()].map(async session => {
      await session.queue;
      await closeSession(session).catch(() => {});
    }));
    if (browserPromise) await (await browserPromise).close();
    await logQueue;
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.BRIDGE_PORT || 7788);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BRIDGE_PORT');
    // The egress proxy gets its own random credentials. Playwright can present proxy credentials to
    // any site that asks for HTTP authentication, so they must never be the service token.
    const proxySecret = randomBytes(24).toString('hex');
    const server = createServer({ token: process.env.BRIDGE_TOKEN, outDir: process.env.BRIDGE_OUT,
      launchBrowser: () => launchHostBrowser(proxySecret) });
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`browse-bridge listening on http://127.0.0.1:${port}`));
    const stop = () => { void server.shutdown().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

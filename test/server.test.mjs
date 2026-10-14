import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { createServer } from '../src/server.mjs';

class FakePage extends EventEmitter {
  constructor(context) {
    super();
    this.context = context;
    this.currentUrl = 'about:blank';
    this.scrollY = 0;
    this.wheels = [];
    this.mouse = { wheel: async (x, y) => { this.wheels.push([x, y]); this.scrollY += y; } };
  }
  async goto(url, options) {
    this.gotoOptions = options;
    this.currentUrl = this.nextFinalUrl || url;
    this.nextFinalUrl = undefined;
    return { status: () => 200 };
  }
  url() { return this.currentUrl; }
  async title() { return 'Fake title'; }
  async content() { return '<!doctype html><title>Fake title</title>'; }
  async screenshot(options) {
    this.lastScreenshot = options;
    await writeFile(options.path, Buffer.alloc(2048, 1));
  }
  async setContent(html) { this.sheetHtml = html; }
  video() { return this.context.options.recordVideo ? { path: async () => path.join(this.context.options.recordVideo.dir, 'generated.webm') } : null; }
  async evaluate(expression, arg) {
    const window = {
      scrollY: this.scrollY,
      scrollBy: ({ top }) => { this.scrollY += top; },
      scrollTo: (_x, y) => { this.scrollY = y; }
    };
    const sandbox = { window, document: { images: [] }, arg };
    return vm.runInNewContext(typeof expression === 'function' ? `(${expression.toString()})(arg)` : expression, sandbox, { timeout: 100 });
  }
}
class FakeContext extends EventEmitter {
  constructor(options) { super(); this.options = options; this.pages = []; }
  async route(pattern, callback) { this.routePattern = pattern; this.routeCallback = callback; }
  async routeWebSocket(pattern, callback) { this.socketCallback = callback; }
  async newPage() { const page = new FakePage(this); this.pages.push(page); this.emit('page', page); return page; }
  async close() { this.closed = true; }
}
class FakeBrowser {
  contexts = [];
  async newContext(options) { const context = new FakeContext(options); this.contexts.push(context); return context; }
  async close() { this.closed = true; }
}

async function fixture(t, launch) {
  const tmp = path.resolve('tmp');
  await mkdir(tmp, { recursive: true });
  const dir = await mkdtemp(path.join(tmp, 'server-test-'));
  const fake = new FakeBrowser();
  const server = createServer({ outDir: dir, token: 'test-secret', launchBrowser: launch || (async () => fake) });
  t.after(async () => { await server.shutdown(); await rm(dir, { recursive: true, force: true }); });
  async function request(endpoint, body, { token = 'test-secret', method = body === undefined ? 'GET' : 'POST', raw } = {}) {
    // Exercise the real HTTP handler and Node message/response classes without
    // opening sockets: this sandbox refuses even loopback listen with EPERM.
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = endpoint;
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    req.complete = true; // The synthetic HTTP parser has delivered the whole body.
    req.headers = { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) };
    req.push(body !== undefined || raw !== undefined ? Buffer.from(raw ?? JSON.stringify(body)) : null);
    if (body !== undefined || raw !== undefined) req.push(null);
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    const originalEnd = res.end;
    let payload;
    res.end = function (chunk, ...args) { payload = chunk; return originalEnd.call(this, chunk, ...args); };
    await new Promise((resolve, reject) => {
      res.once('finish', resolve);
      res.once('error', reject);
      server.emit('request', req, res);
    });
    socket.destroy();
    return { status: res.statusCode, body: JSON.parse(payload) };
  }
  const newSession = async options => {
    const result = await request('/session/new', { viewport: 'desktop', ...options });
    assert.equal(result.status, 200);
    return result.body.session;
  };
  return { dir, fake, server, request, newSession };
}

test('missing or blank token refuses startup before browser launch', () => {
  for (const token of [undefined, '', ' ']) assert.throws(() => createServer({ outDir: process.cwd(), token, launchBrowser() { assert.fail(); } }), /BRIDGE_TOKEN/);
});
test('output must be an existing absolute directory', () => {
  for (const outDir of ['relative', path.resolve('tmp/no-such-directory'), path.resolve('package.json')]) {
    assert.throws(() => createServer({ outDir, token: 'secret', launchBrowser() {} }));
  }
});
test('authentication protects health and unknown endpoints; browser launch stays lazy', async t => {
  let launches = 0;
  const f = await fixture(t, async () => { launches++; return new FakeBrowser(); });
  assert.equal((await f.request('/health', undefined, { token: 'wrong' })).status, 401);
  assert.equal((await f.request('/health', undefined, { token: null })).status, 401);
  assert.equal((await f.request('/unknown', {}, { token: 'wrong' })).status, 401);
  assert.deepEqual((await f.request('/health')).body, { ok: true, sessions: 0 });
  assert.equal(launches, 0);
});
test('unknown endpoint 404 and invalid requests 400', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/unknown', {})).status, 404);
  assert.equal((await f.request('/session/new', {})).status, 400);
  assert.equal((await f.request('/session/new', {}, { raw: '{bad' })).status, 400);
  assert.equal((await f.request('/session/new')).status, 400);
  assert.equal((await f.request('/health', {})).status, 400);
  assert.equal((await f.request('/close', { session: '../../outside' })).status, 400);
  assert.equal((await f.request('/session/new', {}, { raw: ' '.repeat(33000) })).status, 400);
});
test('fresh mobile and custom contexts, motion, recording and close', async t => {
  const f = await fixture(t);
  const first = await f.newSession({ viewport: 'mobile390', reducedMotion: true, record: true });
  const second = await f.newSession({ viewport: { width: 640, height: 1000 } });
  assert.notEqual(first, second);
  assert.deepEqual(f.fake.contexts[0].options, { viewport: { width: 390, height: 844 }, acceptDownloads: false,
    serviceWorkers: 'block', isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce', recordVideo: { dir: path.join(f.dir, first) } });
  assert.deepEqual(f.fake.contexts[1].options.viewport, { width: 640, height: 1000 });
  const closed = await f.request('/close', { session: first });
  assert.equal(closed.body.closed, true);
  assert.ok(closed.body.video.startsWith(path.join(f.dir, first) + path.sep));
  assert.equal(f.fake.contexts[0].closed, true);
  assert.equal((await f.request('/health')).body.sessions, 1);
});
test('concurrent session creation reserves slots before browser launch', async t => {
  let release;
  let entered;
  const launched = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const fake = new FakeBrowser();
  const f = await fixture(t, async () => { entered(); await held; return fake; });
  const pending = Array.from({ length: 4 }, () => f.request('/session/new', { viewport: 'desktop' }));
  await launched;
  release();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 429]);
  assert.equal((await f.request('/health')).body.sessions, 3);
  await f.request('/close', { session: results.find(r => r.status === 200).body.session });
  assert.equal((await f.request('/session/new', { viewport: 'desktop' })).status, 200);
});
test('failed browser launch releases its reserved slot and can retry', async t => {
  let launches = 0;
  const f = await fixture(t, async () => { if (++launches === 1) throw new Error('unavailable'); return new FakeBrowser(); });
  assert.equal((await f.request('/session/new', { viewport: 'desktop' })).status, 500);
  assert.equal((await f.request('/health')).body.sessions, 0);
  await f.newSession();
  assert.equal(launches, 2);
});
test('goto denies forbidden addresses and blanks a forbidden final URL', async t => {
  const f = await fixture(t);
  const session = await f.newSession();
  for (const url of ['file:///etc/hosts', 'http://192.168.1.1', 'http://localhost:3011']) {
    assert.equal((await f.request('/goto', { session, url })).status, 403);
  }
  const result = await f.request('/goto', { session, url: 'https://example.com', waitUntil: 'domcontentloaded' });
  assert.deepEqual(result.body, { status: 200, finalUrl: 'https://example.com', title: 'Fake title' });
  const page = f.fake.contexts[0].pages[0];
  assert.deepEqual(page.gotoOptions, { waitUntil: 'domcontentloaded', timeout: 45000 });
  page.nextFinalUrl = 'file:///etc/hosts';
  assert.equal((await f.request('/goto', { session, url: 'https://example.com' })).status, 403);
  assert.equal(page.url(), 'about:blank');
});
test('routing checks redirects, subframes and subresources; blocks WebSockets', async t => {
  const f = await fixture(t);
  await f.newSession();
  const context = f.fake.contexts[0];
  assert.equal(context.routePattern, '**/*');
  for (const [url, navigation, parent, expected] of [
    ['https://93.184.216.34', true, null, 'continue'],
    ['http://93.184.216.34', true, null, 'abort'],
    ['http://93.184.216.34/a.js', false, null, 'continue'],
    ['data:image/png;base64,AA==', false, null, 'continue'],
    ['http://localhost:3000/app', true, null, 'continue'],
    ['http://10.0.0.1', true, null, 'abort'],
    ['file:///etc/hosts', false, {}, 'abort'],
    ['http://192.168.1.1', true, {}, 'abort']
  ]) {
    let action;
    await context.routeCallback({ request: () => ({ url: () => url, isNavigationRequest: () => navigation, frame: () => ({ parentFrame: () => parent }) }),
      abort: async () => { action = 'abort'; }, continue: async () => { action = 'continue'; } });
    assert.equal(action, expected, url);
  }
  let closed = false;
  context.socketCallback({ close: () => { closed = true; } });
  assert.equal(closed, true);
});
test('scroll modes divide wheel motion and report the current offset', async t => {
  const f = await fixture(t);
  const session = await f.newSession();
  const result = await f.request('/scroll', { session, mode: 'wheel', deltaY: 120, steps: 3, durationMs: 15 });
  assert.equal(result.body.scrollY, 120);
  assert.deepEqual(f.fake.contexts[0].pages[0].wheels, [[0, 40], [0, 40], [0, 40]]);
  assert.equal((await f.request('/scroll', { session, mode: 'smooth', deltaY: 50, durationMs: 0 })).body.scrollY, 170);
  assert.equal((await f.request('/scroll', { session, mode: 'to', y: 10 })).body.scrollY, 10);
});
test('all artifacts remain within the generated session directory, including contact sheet', async t => {
  const f = await fixture(t);
  const session = await f.newSession();
  const context = f.fake.contexts[0];
  context.emit('requestfinished', { url: () => 'https://example.com/site.css', resourceType: () => 'stylesheet' });
  const screenshot = (await f.request('/screenshot', { session, fullPage: true })).body;
  const frames = (await f.request('/frames', { session, everyMs: 50, count: 2 })).body;
  const html = (await f.request('/html', { session })).body;
  for (const file of [screenshot.path, ...frames.paths, frames.contactSheet, html.htmlPath, html.resourcesPath]) {
    assert.ok(file.startsWith(path.join(f.dir, session) + path.sep), file);
    assert.ok((await stat(file)).size > 0);
  }
  assert.equal(frames.paths.length, 2);
  assert.equal(f.fake.contexts[1].closed, true);
  assert.ok(f.fake.contexts[1].pages[0].sheetHtml.includes('data:image/png;base64,'));
  assert.match(await readFile(html.htmlPath, 'utf8'), /Fake title/);
  assert.deepEqual(JSON.parse(await readFile(html.resourcesPath, 'utf8')), [{ url: 'https://example.com/site.css', type: 'stylesheet' }]);
  assert.equal((await f.request('/screenshot', { session, path: '/etc/evil' })).status, 400);
});
test('eval returns JSON and rejects large UTF-8, undefined and cyclic results', async t => {
  const f = await fixture(t);
  const session = await f.newSession();
  assert.deepEqual((await f.request('/eval', { session, expression: '({answer:42})' })).body, { result: { answer: 42 } });
  for (const expression of ['undefined', '"界".repeat(70000)', '(() => { const x = {}; x.self = x; return x; })()']) {
    assert.equal((await f.request('/eval', { session, expression })).status, 400);
  }
});
test('request logs contain statuses and URLs without the authorization token', async t => {
  const f = await fixture(t);
  const session = await f.newSession();
  await f.request('/goto', { session, url: 'file:///etc/hosts' });
  await f.request('/health', undefined, { token: 'wrong-secret' });
  await f.server.shutdown();
  const log = await readFile(path.join(f.dir, 'bridge-log.jsonl'), 'utf8');
  assert.ok(!log.includes('test-secret'));
  assert.ok(!log.includes('wrong-secret'));
  const rows = log.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].status, 403);
  assert.equal(rows[0].session, session);
  assert.equal(rows[1].session, session);
  assert.equal(rows[1].url, 'file:///etc/hosts');
  assert.ok(rows.every(row => typeof row.time === 'string'));
});

test('ten-minute idle cleanup closes the context and frees its slot', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const f = await fixture(t);
  await f.newSession();
  t.mock.timers.tick(599999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.request('/health')).body.sessions, 1);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.request('/health')).body.sessions, 0);
  assert.equal(f.fake.contexts[0].closed, true);
});

test('idle cleanup preserves a session while an operation is running', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const f = await fixture(t);
  const session = await f.newSession();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.fake.contexts[0].pages[0].evaluate = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.request('/eval', { session, expression: '42' });
  await started;
  t.mock.timers.tick(11 * 60 * 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.request('/health')).body.sessions, 1);
  release(42);
  assert.equal((await pending).body.result, 42);
});

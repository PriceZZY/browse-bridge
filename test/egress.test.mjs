import test from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { createEgressProxy, resolveDestination } from '../src/egress.mjs';

test('egress resolves once and pins the checked IP instead of passing a hostname to the socket', async () => {
  let calls = 0;
  const d = await resolveDestination('https://example.com:8443/a', async (host, options) => {
    calls++;
    assert.equal(host, 'example.com');
    assert.equal(options.all, true);
    return [{ address: '93.184.216.34', family: 4 }];
  });
  assert.equal(calls, 1);
  assert.equal(d.address, '93.184.216.34');
  assert.equal(d.port, 8443);
  assert.equal(d.family, 4);
});
test('egress rejects private DNS answers, including mixed public/private and mapped IPv6', async () => {
  for (const addresses of [[], ['10.0.0.1'], ['127.0.0.1'], ['::1'], ['::ffff:192.168.1.1'], ['93.184.216.34', '192.168.1.1']]) {
    await assert.rejects(resolveDestination('https://alias.example', async () => addresses.map(address => ({ address }))));
  }
});
test('only literal loopback development ports bypass external DNS', async () => {
  const unexpectedLookup = () => assert.fail('Literal/localhost must not query DNS');
  assert.equal((await resolveDestination('http://localhost:3000', unexpectedLookup)).address, '127.0.0.1');
  assert.equal((await resolveDestination('http://[::1]:3010', unexpectedLookup)).address, '::1');
  for (const url of ['http://localhost:3011', 'https://localhost:3000', 'http://192.168.1.1', 'file:///etc/hosts']) {
    await assert.rejects(resolveDestination(url, unexpectedLookup));
  }
});
test('egress accepts checked public IPv6 and rejects DNS failure', async () => {
  assert.equal((await resolveDestination('https://example.com', async () => [{ address: '2606:4700:4700::1111' }])).family, 6);
  await assert.rejects(resolveDestination('https://example.com', async () => { throw new Error('DNS failed'); }));
});
test('proxy requires its own authentication before any network connection', async () => {
  const proxy = createEgressProxy('secret');
  const socket = new Duplex({ read() {}, write(_chunk, _enc, cb) { cb(); } });
  const req = new IncomingMessage(socket);
  req.method = 'GET'; req.url = 'http://example.com/'; req.headers = {}; req.complete = true;
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  await new Promise(resolve => { res.once('finish', resolve); proxy.emit('request', req, res); });
  assert.equal(res.statusCode, 407);
  socket.destroy();
  await proxy.shutdown();
});
test('proxy denies authenticated private CONNECT targets without opening sockets', async () => {
  const proxy = createEgressProxy('secret');
  let text = '';
  const socket = new Duplex({ read() {}, write(chunk, _enc, cb) { text += chunk.toString(); cb(); } });
  const ended = new Promise(resolve => socket.once('finish', resolve));
  proxy.emit('connect', { url: '192.168.1.1:443', headers: { 'proxy-authorization': `Basic ${Buffer.from('bridge:secret').toString('base64')}` } }, socket, Buffer.alloc(0));
  await ended;
  assert.match(text, /403 Forbidden/);
  socket.destroy();
  await proxy.shutdown();
});

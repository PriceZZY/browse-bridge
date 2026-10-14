import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isAllowedSubresource, isAllowedTopLevel } from './policy.mjs';

// Resolve once, check every answer, then connect to the chosen literal address.
// Chromium never gets to resolve the destination a second time.
export async function resolveDestination(value, resolve = lookup) {
  const verdict = isAllowedSubresource(value);
  if (!verdict.ok) throw new Error(verdict.reason);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP transport required');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  let address = host;
  if (host === 'localhost') address = '127.0.0.1';
  else if (!net.isIP(host)) {
    const addresses = await resolve(host, { all: true, verbatim: true });
    if (!addresses.length || !addresses.every(({ address: ip }) => net.isIP(ip) &&
      isAllowedTopLevel(`https://${net.isIP(ip) === 6 ? `[${ip}]` : ip}/`).ok)) {
      throw new Error('DNS resolved to a private or reserved address');
    }
    address = addresses[0].address;
  }
  return { address, family: net.isIP(address), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), url };
}

function forwardedHeaders(headers) {
  const result = { ...headers };
  const hopHeaders = ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
  for (const name of (headers.connection || '').split(',')) delete result[name.trim().toLowerCase()];
  for (const name of hopHeaders) delete result[name];
  return result;
}

export function createEgressProxy(token) {
  const hash = value => createHash('sha256').update(value).digest();
  const credentials = `Basic ${Buffer.from(`bridge:${token}`).toString('base64')}`;
  const expected = hash(credentials);
  const authenticated = req => timingSafeEqual(hash(req.headers['proxy-authorization'] || ''), expected);
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };

  const proxy = http.createServer(async (req, res) => {
    if (!authenticated(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="browse-bridge"' });
      res.end();
      return;
    }
    try {
      const destination = await resolveDestination(req.url);
      if (destination.url.protocol !== 'http:') throw new Error('HTTPS requires CONNECT');
      const upstream = http.request({ host: destination.address, family: destination.family, port: destination.port,
        method: req.method, path: `${destination.url.pathname}${destination.url.search}`, agent: false,
        headers: { ...forwardedHeaders(req.headers), host: destination.url.host } }, response => {
        res.writeHead(response.statusCode, forwardedHeaders(response.headers));
        response.pipe(res);
        response.on('error', () => res.destroy());
      });
      upstream.on('socket', track);
      upstream.setTimeout(45000, () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch {
      res.writeHead(403);
      res.end('Destination forbidden');
      req.resume();
    }
  });
  proxy.on('connection', track);
  proxy.on('connect', async (req, client, head) => {
    if (!authenticated(req)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="browse-bridge"\r\nConnection: close\r\n\r\n');
      return;
    }
    try {
      const destination = await resolveDestination(`https://${req.url}`);
      if (destination.url.pathname !== '/' || destination.url.search || destination.url.hash) throw new Error('Invalid CONNECT authority');
      const upstream = track(net.connect({ host: destination.address, port: destination.port, family: destination.family }));
      upstream.setTimeout(60000, () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  proxy.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  proxy.shutdown = async () => {
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
  };
  return proxy;
}

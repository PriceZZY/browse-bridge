const yes = () => ({ ok: true, reason: '' });
const no = reason => ({ ok: false, reason });

function ipv4Public(host) {
  const p = host.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  // Reject 0.0.0.0/8 and all non-public, private, documentation and multicast ranges.
  return !(a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || a === 127 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) || a >= 224);
}

function ipv6Public(host) {
  const sides = host.split('::');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  const parts = sides.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (parts.length !== 8) return false;
  const words = parts.map(p => parseInt(p, 16));
  // Only global unicast 2000::/3; reject documentation and special-purpose allocations.
  return words.every(n => Number.isInteger(n)) && (words[0] & 0xe000) === 0x2000 &&
    !(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) &&
    !((words[0] & 0xfff0) === 0x3ff0) && !(words[0] === 0x2002);
}

function allowed(value, subresource) {
  if (typeof value !== 'string') return no('URL must be a string');
  let url;
  try { url = new URL(value); } catch { return no('Invalid URL'); }
  if (url.username || url.password) return no('URL credentials are forbidden');
  if (url.href === 'about:blank') return yes();
  if (subresource && (url.protocol === 'data:' || url.protocol === 'blob:')) return yes();
  if (!['http:', 'https:'].includes(url.protocol)) return no('Protocol is forbidden');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (local) {
    return url.protocol === 'http:' && Number(url.port) >= 3000 && Number(url.port) <= 3010
      ? yes() : no('Loopback requires HTTP port 3000–3010');
  }
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) return no('Private hostname');
  if (host.startsWith('[')) {
    if (!ipv6Public(host.slice(1, -1))) return no('Private or reserved IPv6 address');
  } else if (/^[\d.]+$/.test(host)) {
    if (!ipv4Public(host)) return no('Private or reserved IPv4 address');
  } else if (!host.includes('.') || !/^[a-z\d.-]+$/.test(host) || host.split('.').some(p => !p || p.startsWith('-') || p.endsWith('-'))) {
    return no('Public hostname required');
  }
  if (url.protocol === 'http:' && !subresource) return no('External top-level URL requires HTTPS');
  return yes();
}

export const isAllowedTopLevel = url => allowed(url, false);
export const isAllowedSubresource = url => allowed(url, true);

const integer = (v, low, high) => Number.isInteger(v) && v >= low && v <= high;
const number = v => typeof v === 'number' && Number.isFinite(v);
const optional = (body, key, check) => body[key] === undefined || check(body[key]);
const bool = v => typeof v === 'boolean';
const fields = {
  '/session/new': ['viewport', 'reducedMotion', 'record'],
  '/goto': ['session', 'url', 'waitUntil'],
  '/scroll': ['session', 'mode', 'deltaY', 'steps', 'durationMs', 'y'],
  '/screenshot': ['session', 'fullPage'],
  '/frames': ['session', 'everyMs', 'count'],
  '/html': ['session'], '/eval': ['session', 'expression'], '/close': ['session']
};

export function validateBody(endpoint, body) {
  if (!fields[endpoint]) return no('Unknown endpoint');
  if (!body || typeof body !== 'object' || Array.isArray(body)) return no('JSON object required');
  if (Object.keys(body).some(k => !fields[endpoint].includes(k))) return no('Unknown parameter');
  if (endpoint !== '/session/new' && (typeof body.session !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(body.session))) return no('Invalid session');
  let valid;
  switch (endpoint) {
    case '/session/new': {
      const v = body.viewport;
      valid = (v === 'desktop' || v === 'mobile390' || (v && typeof v === 'object' && !Array.isArray(v) &&
        Object.keys(v).length === 2 && integer(v.width, 320, 2560) && integer(v.height, 480, 2000))) &&
        optional(body, 'reducedMotion', bool) && optional(body, 'record', bool);
      break;
    }
    case '/goto':
      valid = typeof body.url === 'string' && body.url.length > 0 && body.url.length <= 8192 &&
        optional(body, 'waitUntil', v => ['load', 'domcontentloaded', 'networkidle'].includes(v));
      if (valid) { try { new URL(body.url); } catch { valid = false; } }
      break;
    case '/scroll':
      valid = ['wheel', 'smooth', 'to'].includes(body.mode) &&
        optional(body, 'deltaY', number) && optional(body, 'y', number) &&
        optional(body, 'steps', v => integer(v, 1, 400)) && optional(body, 'durationMs', v => integer(v, 0, 20000)) &&
        (body.mode === 'to' ? number(body.y) && body.y >= 0 : number(body.deltaY));
      break;
    case '/screenshot': valid = optional(body, 'fullPage', bool); break;
    case '/frames': valid = integer(body.everyMs, 50, 2000) && integer(body.count, 1, 60); break;
    case '/eval': valid = typeof body.expression === 'string' && body.expression.length > 0 && body.expression.length <= 4000; break;
    default: valid = true;
  }
  return valid ? yes() : no('Invalid parameter type or range');
}

'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { verifyPassword, DUMMY_HASH, parseCookies } = require('./auth');
const { humanDuration } = require('./duration');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const STATIC = new Map([
  ['style.css', 'text/css; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'],
  ['login.js', 'text/javascript; charset=utf-8'],
  ['qr.js', 'text/javascript; charset=utf-8'],
]);
const COOKIE = 'qrwifi_session';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function defaultLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new HttpError(413, 'Request too large.'));
      if (size === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function createApp({ config, store, staff, router, vouchers, sessions, limiter, lanIp = defaultLanIp, log = () => {} }) {
  function securityHeaders(res) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    res.end(text);
  }

  function html(res, status, text) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    res.end(text);
  }

  function redirect(res, location) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  }

  async function sendPublic(res, name, type) {
    try {
      const body = await fsp.readFile(path.join(PUBLIC_DIR, name));
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (err) {
      if (err.code === 'ENOENT') return json(res, 404, { error: 'Not found.' });
      throw err;
    }
  }

  function currentSession(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = sessions.get(token);
    if (!session) return null;
    if (!staff.get(session.username)) {
      sessions.destroy(token);
      return null;
    }
    return { token, username: session.username };
  }

  const sessionCookie = (value, maxAgeSec) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${config.cookieSecure ? '; Secure' : ''}`;

  // Where the customer's phone can reach this app (demo mode only): never "localhost".
  function originFor(req) {
    const host = String(req.headers.host || '');
    const okHost = /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) || /^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(host);
    if (!okHost) return `http://localhost:${config.port}`;
    const hostname = host.replace(/:\d+$/, '').toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
      const ip = lanIp();
      if (ip) return `http://${ip}:${config.port}`;
    }
    return `http://${host}`;
  }

  function voucherView(v, origin) {
    const out = {
      id: v.id,
      code: v.code,
      status: v.status,
      durationMinutes: v.durationMinutes,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      redeemedAt: v.redeemedAt,
      expiresAt: v.expiresAt,
      endedAt: v.endedAt,
      endReason: v.endReason,
      endedBy: v.endedBy || null,
    };
    if (v.status === 'unused' || v.status === 'active') out.loginUrl = vouchers.loginUrl(v.code, origin);
    return out;
  }

  async function login(req, res) {
    const ip = req.socket.remoteAddress || 'unknown';
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const ipKey = `ip:${ip}`;
    const pairKey = `pair:${ip}|${username}`;

    for (const key of [ipKey, pairKey]) {
      const check = limiter.check(key);
      if (!check.allowed) {
        res.setHeader('Retry-After', String(check.retryAfterSec));
        return json(res, 429, { error: `Too many attempts. Try again in ${Math.max(1, Math.ceil(check.retryAfterSec / 60))} min.` });
      }
    }

    const record = username ? staff.get(username) : null;
    const ok = await verifyPassword(password, record ? record.hash : DUMMY_HASH);
    if (!record || !ok) {
      limiter.fail(ipKey, 20);
      limiter.fail(pairKey, 5);
      return json(res, 401, { error: 'Wrong username or password.' });
    }
    limiter.success(pairKey);
    const token = sessions.create(record.username);
    res.setHeader('Set-Cookie', sessionCookie(token, Math.floor(config.sessionHours * 3600)));
    return json(res, 200, { username: record.username });
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (req.method !== 'GET' && req.headers['x-qrwifi'] !== '1') {
      throw new HttpError(403, 'Missing request header.');
    }
    if (route === 'GET /api/branding') return json(res, 200, { cafeName: config.cafeName });
    if (route === 'POST /api/login') return login(req, res);

    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please log in.' });

    if (route === 'POST /api/logout') {
      sessions.destroy(session.token);
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      return json(res, 200, { ok: true });
    }

    if (route === 'GET /api/vouchers') {
      const origin = originFor(req);
      return json(res, 200, {
        now: Date.now(),
        user: session.username,
        branding: { cafeName: config.cafeName, wifiName: config.wifiName },
        router: vouchers.status(),
        voucherConfig: {
          durationMinutes: config.voucher.durationMinutes,
          durationOptionsMinutes: config.voucher.durationOptionsMinutes,
          unusedExpiryHours: config.voucher.unusedExpiryHours,
        },
        vouchers: vouchers.list().map((v) => voucherView(v, origin)),
      });
    }

    if (route === 'POST /api/vouchers') {
      const body = await readJson(req);
      const voucher = await vouchers.generate(session.username, body.durationMinutes);
      log(`${session.username} generated a voucher`);
      return json(res, 200, { voucher: voucherView(voucher, originFor(req)) });
    }

    const revoke = url.pathname.match(/^\/api\/vouchers\/([0-9a-f]{12})\/revoke$/);
    if (req.method === 'POST' && revoke) {
      const voucher = await vouchers.revoke(revoke[1], session.username);
      log(`${session.username} revoked a voucher`);
      return json(res, 200, { voucher: voucherView(voucher, originFor(req)) });
    }

    return json(res, 404, { error: 'Not found.' });
  }

  // ---- demo hotspot pages (mock router only) -------------------------------------------

  function portalPage(heading, bodyHtml) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.cafeName)} Wi-Fi</title><link rel="stylesheet" href="/static/style.css"></head>
<body class="portal-body"><main class="portal">
<p class="portal-note">Demo hotspot page. With a real MikroTik, the router shows this step instead.</p>
<h1>${escapeHtml(heading)}</h1>${bodyHtml}
</main></body></html>`;
  }

  function deviceId(req) {
    const raw = `${req.socket.remoteAddress}|${req.headers['user-agent'] || ''}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  }

  function mockLogin(req, res, url) {
    const p = url.searchParams;
    const typed = (p.get('code') || '').trim().toUpperCase();
    let username = (p.get('username') || '').trim();
    let password = p.get('password');
    if (!username && typed) username = typed;
    if (!username) {
      return html(res, 200, portalPage('Enter your voucher code', `
<form method="get" action="/mock/login" class="portal-form">
  <label for="code">Voucher code</label>
  <input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
  <button class="btn btn-primary" type="submit">Connect</button>
</form>`));
    }
    if (password === null) password = username;
    const result = router.login({ username, password, device: deviceId(req) });
    if (!result.ok) {
      return html(res, 200, portalPage("Can't connect", `<p class="portal-error">${escapeHtml(result.error)}</p>
<p>Ask the staff for a new voucher.</p>`));
    }
    return html(res, 200, portalPage("You're connected", `<p>${result.already ? 'This device is already connected.' : 'Enjoy the Wi-Fi.'}
Time left on this voucher: <strong>${escapeHtml(humanDuration(result.remainingSec))}</strong>.</p>
<p><a class="btn btn-quiet" href="/mock/logout">Disconnect this device</a></p>`));
  }

  function mockLogout(req, res) {
    router.logout(deviceId(req));
    return html(res, 200, portalPage('Disconnected', '<p>Scan the same QR code again to reconnect while time is left on the voucher.</p>'));
  }

  // ---- request entry point ---------------------------------------------------------------

  async function handle(req, res) {
    securityHeaders(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { ok: true });

      if (req.method === 'GET' && (pathname === '/' || pathname === '/login')) {
        const session = currentSession(req);
        if (pathname === '/' && !session) return redirect(res, '/login');
        if (pathname === '/login' && session) return redirect(res, '/');
        return sendPublic(res, pathname === '/' ? 'index.html' : 'login.html', 'text/html; charset=utf-8');
      }

      if (req.method === 'GET' && pathname.startsWith('/static/')) {
        const name = pathname.slice('/static/'.length);
        if (STATIC.has(name)) return sendPublic(res, name, STATIC.get(name));
        return json(res, 404, { error: 'Not found.' });
      }

      if (router.mode === 'mock' && req.method === 'GET' && pathname === '/mock/login') return mockLogin(req, res, url);
      if (router.mode === 'mock' && req.method === 'GET' && pathname === '/mock/logout') return mockLogout(req, res);

      if (pathname.startsWith('/api/')) return await api(req, res, url);

      return json(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (err && err.status && err.status < 500) return json(res, err.status, { error: err.message });
      if (err && err.name === 'VoucherError') return json(res, err.status, { error: err.message });
      log(`unexpected error: ${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) return json(res, 500, { error: 'Something went wrong on the server.' });
      res.end();
    }
  }

  return { handle };
}

module.exports = { createApp, HttpError, escapeHtml };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, addStaff, startServer, client } = require('./helpers');

async function setup(overrides) {
  const env = makeEnv(overrides);
  addStaff(env, 'maria', 'correct-password');
  const srv = await startServer(env);
  return { env, srv, c: client(srv.base) };
}

async function loggedIn(overrides) {
  const ctx = await setup(overrides);
  const res = await ctx.c.call('POST', '/api/login', { body: { username: 'maria', password: 'correct-password' } });
  assert.equal(res.status, 200);
  return ctx;
}

test('pages: redirects by login state, serves static files, hides everything else', async () => {
  const { srv, c } = await setup();
  try {
    let r = await c.call('GET', '/', { raw: true });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');

    r = await c.call('GET', '/login', { raw: true });
    assert.equal(r.status, 200);
    assert.match(r.text, /Staff log in/);

    for (const f of ['style.css', 'app.js', 'login.js', 'qr.js']) {
      r = await c.call('GET', `/static/${f}`, { raw: true });
      assert.equal(r.status, 200, f);
    }
    for (const bad of ['/static/../server.js', '/static/%2e%2e/server.js', '/static/..%2fconfig.json', '/static/index.html', '/static/', '/nope', '/data/store.json', '/lib/auth.js']) {
      r = await c.call('GET', bad, { raw: true });
      assert.equal(r.status, 404, bad);
    }
    r = await c.call('GET', '/healthz');
    assert.deepEqual(r.data, { ok: true });
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  } finally {
    await srv.close();
  }
});

test('api requires login', async () => {
  const { srv, c } = await setup();
  try {
    for (const [method, url] of [['GET', '/api/vouchers'], ['POST', '/api/vouchers'], ['POST', '/api/logout'], ['POST', '/api/vouchers/aaaaaaaaaaaa/revoke']]) {
      const r = await c.call(method, url, { body: method === 'POST' ? {} : undefined });
      assert.equal(r.status, 401, `${method} ${url}`);
    }
  } finally {
    await srv.close();
  }
});

test('login: wrong password, unknown user, success, logout', async () => {
  const { srv, c } = await setup();
  try {
    let r = await c.call('POST', '/api/login', { body: { username: 'maria', password: 'nope' } });
    assert.equal(r.status, 401);
    assert.equal(r.data.error, 'Wrong username or password.');
    r = await c.call('POST', '/api/login', { body: { username: 'ghost', password: 'nope' } });
    assert.equal(r.status, 401);
    assert.equal(r.data.error, 'Wrong username or password.', 'same message for unknown users');
    r = await c.call('POST', '/api/login', { body: { username: 'maria', password: { $ne: 1 } } });
    assert.equal(r.status, 401);
    r = await c.call('POST', '/api/login', { body: 'not an object' });
    assert.equal(r.status, 401);

    r = await c.call('POST', '/api/login', { body: { username: ' Maria ', password: 'correct-password' } });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/);

    r = await c.call('GET', '/', { raw: true });
    assert.equal(r.status, 200);
    r = await c.call('GET', '/login', { raw: true });
    assert.equal(r.status, 302);

    r = await c.call('POST', '/api/logout', { body: {} });
    assert.equal(r.status, 200);
    r = await c.call('GET', '/api/vouchers');
    assert.equal(r.status, 401);
  } finally {
    await srv.close();
  }
});

test('login: repeated failures lock the account for that address', async () => {
  const { srv, c } = await setup();
  try {
    for (let i = 0; i < 5; i++) {
      const r = await c.call('POST', '/api/login', { body: { username: 'maria', password: `wrong${i}` } });
      assert.equal(r.status, 401);
    }
    let r = await c.call('POST', '/api/login', { body: { username: 'maria', password: 'correct-password' } });
    assert.equal(r.status, 429, 'even the right password is refused while locked');
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.match(r.data.error, /Too many attempts/);
  } finally {
    await srv.close();
  }
});

test('cookie secure flag follows the config', async () => {
  const { srv, c } = await setup({ cookieSecure: true });
  try {
    const r = await c.call('POST', '/api/login', { body: { username: 'maria', password: 'correct-password' } });
    assert.match(r.headers.get('set-cookie'), /; Secure/);
  } finally {
    await srv.close();
  }
});

test('state-changing requests need the custom header (CSRF guard)', async () => {
  const { srv, c } = await loggedIn();
  try {
    let r = await c.call('POST', '/api/vouchers', { body: { durationMinutes: 60 }, headers: { 'X-QRWifi': '' } });
    assert.equal(r.status, 403);
    r = await c.call('POST', '/api/login', { body: { username: 'maria', password: 'x' }, headers: { 'X-QRWifi': '' } });
    assert.equal(r.status, 403);
    r = await c.call('GET', '/api/vouchers', { headers: { 'X-QRWifi': '' } });
    assert.equal(r.status, 200, 'reads are fine without it');
  } finally {
    await srv.close();
  }
});

test('generate, list, revoke through the API', async () => {
  const { env, srv, c } = await loggedIn();
  try {
    let r = await c.call('POST', '/api/vouchers', { body: { durationMinutes: 180 } });
    assert.equal(r.status, 200);
    const v = r.data.voucher;
    assert.equal(v.status, 'unused');
    assert.equal(v.createdBy, 'maria');
    // the QR must point at the LAN address and the configured port, not whatever port the test server got
    assert.equal(v.loginUrl, `http://192.168.1.50:${env.config.port}/mock/login?username=${v.code}&password=${v.code}`);
    assert.equal(v.routerUserId, undefined, 'internal fields are not exposed');

    r = await c.call('POST', '/api/vouchers', { body: { durationMinutes: 7 } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /listed durations/);

    r = await c.call('GET', '/api/vouchers');
    assert.equal(r.status, 200);
    assert.equal(r.data.user, 'maria');
    assert.equal(r.data.router.mode, 'mock');
    assert.equal(r.data.vouchers.length, 1);
    assert.deepEqual(r.data.voucherConfig.durationOptionsMinutes, [60, 120, 180]);
    assert.equal(typeof r.data.now, 'number');

    r = await c.call('POST', `/api/vouchers/${v.id}/revoke`, { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.data.voucher.status, 'revoked');
    assert.equal(r.data.voucher.loginUrl, undefined, 'ended vouchers have no login link');
    r = await c.call('POST', `/api/vouchers/${v.id}/revoke`, { body: {} });
    assert.equal(r.status, 409);
    r = await c.call('POST', '/api/vouchers/not-an-id/revoke', { body: {} });
    assert.equal(r.status, 404);
    assert.equal(env.store.data.events.filter((e) => e.action === 'revoke').length, 1);
  } finally {
    await srv.close();
  }
});

test('malformed and oversized request bodies are rejected without crashing', async () => {
  const { srv, c } = await loggedIn();
  try {
    let res = await fetch(`${srv.base}/api/vouchers`, {
      method: 'POST',
      headers: { 'X-QRWifi': '1', 'Content-Type': 'application/json', Cookie: c.cookie },
      body: '{oops',
    });
    assert.equal(res.status, 400);
    res = await fetch(`${srv.base}/api/vouchers`, {
      method: 'POST',
      headers: { 'X-QRWifi': '1', 'Content-Type': 'application/json', Cookie: c.cookie },
      body: JSON.stringify({ durationMinutes: 60, junk: 'x'.repeat(50_000) }),
    });
    assert.equal(res.status, 413);
    const ok = await c.call('GET', '/api/vouchers');
    assert.equal(ok.status, 200, 'server still healthy');
  } finally {
    await srv.close();
  }
});

test('a removed staff account loses access immediately', async () => {
  const { env, srv, c } = await loggedIn();
  try {
    assert.equal((await c.call('GET', '/api/vouchers')).status, 200);
    env.staff.remove('maria');
    assert.equal((await c.call('GET', '/api/vouchers')).status, 401);
  } finally {
    await srv.close();
  }
});

test('demo hotspot: scanning the QR connects once, a second device is refused, disconnect works', async () => {
  const { env, srv, c } = await loggedIn();
  try {
    const { voucher } = (await c.call('POST', '/api/vouchers', { body: { durationMinutes: 180 } })).data;
    const path = new URL(voucher.loginUrl).pathname + new URL(voucher.loginUrl).search;

    const phoneA = { 'User-Agent': 'Phone A' };
    let res = await fetch(srv.base + path, { headers: phoneA });
    let text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /You(?:'|&#39;)re connected/);
    assert.match(text, /3h/);

    res = await fetch(srv.base + path, { headers: { 'User-Agent': 'Phone B' } });
    text = await res.text();
    assert.match(text, /already in use on another device/);

    await env.vouchers.sync();
    assert.equal(env.vouchers.list()[0].status, 'active');

    res = await fetch(`${srv.base}/mock/logout`, { headers: phoneA });
    assert.match(await res.text(), /Disconnected/);
    res = await fetch(srv.base + path, { headers: { 'User-Agent': 'Phone B' } });
    assert.match(await res.text(), /You(?:'|&#39;)re connected/, 'after disconnecting, the voucher can move to another device');

    res = await fetch(`${srv.base}/mock/login?username=ZZZZZZZZ&password=ZZZZZZZZ`);
    assert.match(await res.text(), /not valid/);

    res = await fetch(`${srv.base}/mock/login`);
    assert.match(await res.text(), /Enter your voucher code/);
    res = await fetch(`${srv.base}/mock/login?code=${voucher.code.toLowerCase()}`, { headers: phoneA });
    assert.match(await res.text(), /already in use on another device|You(?:'|&#39;)re connected/, 'typed codes are case-insensitive');
  } finally {
    await srv.close();
  }
});

test('demo hotspot pages escape anything echoed back and do not exist in real-router mode', async () => {
  const { srv } = await setup();
  try {
    const res = await fetch(`${srv.base}/mock/login?username=%3Cscript%3Ealert(1)%3C/script%3E&password=x`);
    const text = await res.text();
    assert.doesNotMatch(text, /<script>alert/);
  } finally {
    await srv.close();
  }
  const env = makeEnv();
  env.router.mode = 'routeros';
  const real = await startServer(env);
  try {
    const res = await fetch(`${real.base}/mock/login`);
    assert.equal(res.status, 404);
  } finally {
    await real.close();
  }
});

test('QR link uses the LAN address when staff open the page via localhost', async () => {
  const { srv, c } = await loggedIn();
  try {
    const r = await c.call('POST', '/api/vouchers', { body: { durationMinutes: 60 }, headers: { Host: 'localhost:3000' } });
    assert.match(r.data.voucher.loginUrl, /^http:\/\/192\.168\.1\.50:/);
  } finally {
    await srv.close();
  }
});

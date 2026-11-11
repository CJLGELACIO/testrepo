'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { merge, DEFAULTS, validate } = require('../lib/config');
const { Store } = require('../lib/store');
const { StaffFile } = require('../lib/staff');
const { Sessions, LoginLimiter, hashPassword } = require('../lib/auth');
const { MockRouter } = require('../lib/router-mock');
const { VoucherService } = require('../lib/vouchers');
const { createApp } = require('../lib/app');

function makeClock(start = 1_700_000_000_000) {
  const clock = () => clock.now;
  clock.now = start;
  clock.advance = (ms) => { clock.now += ms; };
  return clock;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qrwifi-test-'));
}

function makeEnv(overrides = {}) {
  const dir = tmpDir();
  const clock = makeClock();
  const config = merge(DEFAULTS, {
    dataFile: path.join(dir, 'store.json'),
    staffFile: path.join(dir, 'staff.json'),
    router: { mode: 'mock', mockStateFile: path.join(dir, 'mock.json') },
    ...overrides,
  });
  validate(config);
  const store = new Store(config.dataFile).load();
  const staff = new StaffFile(config.staffFile);
  const router = new MockRouter({ stateFile: config.router.mockStateFile, clock });
  const vouchers = new VoucherService({ store, router, config, clock });
  const sessions = new Sessions(config.sessionHours * 3_600_000, clock);
  const limiter = new LoginLimiter({ clock });
  return { dir, clock, config, store, staff, router, vouchers, sessions, limiter };
}

function addStaff(env, name, password) {
  env.staff.set(name, hashPassword(password));
}

async function startServer(env, extra = {}) {
  const app = createApp({ ...env, lanIp: () => '192.168.1.50', ...extra });
  const server = http.createServer((req, res) => { app.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

// A tiny cookie-keeping client.
function client(base) {
  let cookie = '';
  async function call(method, urlPath, { body, headers = {}, raw = false } = {}) {
    const res = await fetch(base + urlPath, {
      method,
      redirect: 'manual',
      headers: {
        'X-QRWifi': '1',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let data = null;
    if (!raw) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    return { status: res.status, headers: res.headers, text, data };
  }
  return { call, get cookie() { return cookie; } };
}

module.exports = { makeClock, makeEnv, addStaff, startServer, client, tmpDir };

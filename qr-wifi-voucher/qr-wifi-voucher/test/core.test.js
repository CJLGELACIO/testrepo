'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseRosDuration, formatRosDuration, humanDuration } = require('../lib/duration');
const { hashPassword, verifyPassword, Sessions, LoginLimiter, parseCookies } = require('../lib/auth');
const { merge, DEFAULTS, validate, loadConfig } = require('../lib/config');
const { StaffFile } = require('../lib/staff');
const { Store } = require('../lib/store');
const { makeClock, tmpDir } = require('./helpers');

test('RouterOS durations parse and format', () => {
  assert.equal(parseRosDuration('3h'), 10800);
  assert.equal(parseRosDuration('1h30m'), 5400);
  assert.equal(parseRosDuration('2d4h'), 2 * 86400 + 4 * 3600);
  assert.equal(parseRosDuration('59m59s'), 3599);
  assert.equal(parseRosDuration('1w'), 604800);
  assert.equal(parseRosDuration('01:30:00'), 5400);
  assert.equal(parseRosDuration('1d 02:00:00'), 86400 + 7200);
  assert.equal(parseRosDuration('0s'), 0);
  assert.equal(parseRosDuration(''), 0);
  assert.equal(parseRosDuration(undefined), 0);
  assert.equal(parseRosDuration('garbage'), 0);
  assert.equal(parseRosDuration('12'), 12);
  assert.equal(formatRosDuration(10800), '3h');
  assert.equal(formatRosDuration(5400), '1h30m');
  assert.equal(formatRosDuration(0), '0s');
  assert.equal(formatRosDuration(90061), '1d1h1m1s');
  for (const s of [1, 59, 60, 3599, 3600, 10799, 86399, 200000]) {
    assert.equal(parseRosDuration(formatRosDuration(s)), s);
  }
  assert.equal(humanDuration(10800), '3h');
  assert.equal(humanDuration(9000), '2h 30m');
  assert.equal(humanDuration(2700), '45m');
  assert.equal(humanDuration(30), '30s');
});

test('passwords: hash, verify, reject wrong, reject malformed hashes', async () => {
  const hash = hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batterz', hash), false);
  assert.equal(await verifyPassword('', hash), false);
  assert.notEqual(hashPassword('same'), hashPassword('same'), 'salted');
  for (const bad of ['', 'x', 'scrypt$1$2$3$4', 'bcrypt$16384$8$1$AAAA$AAAA', 'scrypt$999999999$8$1$AAAA$AAAA', 'scrypt$16384$8$1$AAAA$']) {
    assert.equal(await verifyPassword('x', bad), false);
  }
  assert.equal(await verifyPassword(undefined, hash), false);
});

test('sessions expire and can be destroyed', () => {
  const clock = makeClock();
  const sessions = new Sessions(1000, clock);
  const token = sessions.create('alice');
  assert.equal(sessions.get(token).username, 'alice');
  assert.equal(sessions.get('nope'), null);
  assert.equal(sessions.get(undefined), null);
  clock.advance(999);
  assert.ok(sessions.get(token));
  clock.advance(2);
  assert.equal(sessions.get(token), null);
  const t2 = sessions.create('bob');
  sessions.destroy(t2);
  assert.equal(sessions.get(t2), null);
});

test('login limiter locks after repeated failures and recovers', () => {
  const clock = makeClock();
  const limiter = new LoginLimiter({ maxFailures: 3, lockMs: 60_000, windowMs: 600_000, clock });
  assert.equal(limiter.check('k').allowed, true);
  limiter.fail('k');
  limiter.fail('k');
  assert.equal(limiter.check('k').allowed, true);
  limiter.fail('k');
  const locked = limiter.check('k');
  assert.equal(locked.allowed, false);
  assert.equal(locked.retryAfterSec, 60);
  assert.equal(limiter.check('other').allowed, true);
  clock.advance(60_001);
  assert.equal(limiter.check('k').allowed, true);
  limiter.fail('k');
  limiter.success('k');
  limiter.fail('k');
  limiter.fail('k');
  assert.equal(limiter.check('k').allowed, true, 'success reset the count');
});

test('cookie parsing', () => {
  assert.deepEqual(parseCookies('a=1; b=two%20words; c'), { a: '1', b: 'two words' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('bad=%E0%A4%A; ok=1'), { ok: '1' });
});

test('config: defaults validate, bad values are rejected with plain messages', () => {
  const cfg = merge(DEFAULTS, {});
  assert.doesNotThrow(() => validate(cfg));
  assert.throws(() => validate(merge(DEFAULTS, { port: 70000 })), /port/);
  assert.throws(() => validate(merge(DEFAULTS, { voucher: { codeLength: 3 } })), /codeLength/);
  assert.throws(() => validate(merge(DEFAULTS, { voucher: { durationOptionsMinutes: [] } })), /durationOptionsMinutes/);
  assert.throws(() => validate(merge(DEFAULTS, { router: { mode: 'banana' } })), /router.mode/);
  assert.throws(() => validate(merge(DEFAULTS, { router: { mode: 'routeros', password: '' } })), /password/);
  const withDefault = merge(DEFAULTS, { voucher: { durationMinutes: 45, durationOptionsMinutes: [60, 120] } });
  validate(withDefault);
  assert.deepEqual(withDefault.voucher.durationOptionsMinutes, [45, 60, 120], 'default duration is always selectable');
  assert.doesNotThrow(() => validate(merge(DEFAULTS, {
    router: { mode: 'routeros', url: 'https://10.0.0.1', username: 'u', password: 'p', loginUrl: 'http://10.0.0.1/login' },
  })));
});

test('config: prototype pollution through config.json is ignored', () => {
  const merged = merge(DEFAULTS, JSON.parse('{"__proto__":{"polluted":true},"voucher":{"__proto__":{"x":1}}}'));
  assert.equal({}.polluted, undefined);
  assert.equal({}.x, undefined);
  assert.equal(merged.polluted, undefined);
});

test('config: loadConfig reads a file, applies env password, and explains broken JSON', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ cafeName: 'Kape Tayo', port: 4321, router: { mode: 'mock' } }));
  const cfg = loadConfig(file);
  assert.equal(cfg.cafeName, 'Kape Tayo');
  assert.equal(cfg.port, 4321);
  assert.ok(path.isAbsolute(cfg.dataFile));
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => loadConfig(file), /Could not read/);
});

test('staff file: add, list, remove, picks up outside edits', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'staff.json');
  const staff = new StaffFile(file);
  assert.equal(staff.count(), 0);
  staff.set('Maria', hashPassword('password1'));
  assert.equal(staff.get('maria').username, 'maria');
  assert.equal(staff.get('MARIA').username, 'maria');
  assert.deepEqual(staff.list().map((u) => u.username), ['maria']);
  assert.throws(() => staff.set('a b', 'x'), /Usernames/);
  assert.equal(staff.get('__proto__'), null);
  assert.equal(staff.get('constructor'), null);

  const other = new StaffFile(file); // like the CLI running in another process
  other.set('jun', hashPassword('password2'));
  assert.equal(staff.count(), 2, 'server sees accounts added by the CLI');
  assert.equal(other.remove('maria'), true);
  assert.equal(staff.get('maria'), null, 'removed account is gone right away');
  assert.equal(other.remove('maria'), false);
});

test('store: round trip, atomic write, refuses to overwrite a corrupt file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'store.json');
  const store = new Store(file).load();
  assert.deepEqual(store.data.vouchers, []);
  store.data.vouchers.push({ id: 'a' });
  store.save();
  assert.equal(new Store(file).load().data.vouchers[0].id, 'a');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['store.json'], 'no temp files left behind');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new Store(file).load(), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken', 'corrupt file left untouched');
});

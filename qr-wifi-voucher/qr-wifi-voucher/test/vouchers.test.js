'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ALPHABET, VoucherError } = require('../lib/vouchers');
const { makeEnv } = require('./helpers');

const MIN = 60_000;
const HOUR = 3_600_000;

test('generate creates a router user and a record', async () => {
  const env = makeEnv();
  const v = await env.vouchers.generate('maria', 180);
  assert.equal(v.status, 'unused');
  assert.equal(v.durationMinutes, 180);
  assert.equal(v.createdBy, 'maria');
  assert.equal(v.code.length, 8);
  for (const ch of v.code) assert.ok(ALPHABET.includes(ch), `${ch} is in the readable alphabet`);
  const users = await env.router.listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].name, v.code);
  assert.equal(users[0].limitUptime, '3h');
  assert.ok(users[0].comment.startsWith('qrwifi:'));
  assert.equal(env.store.data.events.at(-1).action, 'generate');
});

test('generate validates the duration and uses the configured default', async () => {
  const env = makeEnv();
  await assert.rejects(env.vouchers.generate('m', 999), (e) => e instanceof VoucherError && e.status === 400);
  await assert.rejects(env.vouchers.generate('m', 1.5), VoucherError);
  await assert.rejects(env.vouchers.generate('m', '180'), VoucherError);
  const v = await env.vouchers.generate('m');
  assert.equal(v.durationMinutes, 180);
});

test('codes are unique across many vouchers', async () => {
  const env = makeEnv();
  const codes = new Set();
  for (let i = 0; i < 60; i++) codes.add((await env.vouchers.generate('m', 60)).code);
  assert.equal(codes.size, 60);
});

test('maxUnused caps how many unredeemed vouchers pile up', async () => {
  const env = makeEnv({ voucher: { maxUnused: 3 } });
  for (let i = 0; i < 3; i++) await env.vouchers.generate('m', 60);
  await assert.rejects(env.vouchers.generate('m', 60), (e) => e.status === 429);
});

test('three-hour window starts at first connection, not at creation', async () => {
  const env = makeEnv();
  const v = await env.vouchers.generate('maria', 180);
  const login = () => env.router.login({ username: v.code, password: v.code, device: 'phone-1' });

  env.clock.advance(45 * MIN); // customer takes a while to scan
  await env.vouchers.sync();
  assert.equal(v.status, 'unused');

  assert.equal(login().ok, true);
  await env.vouchers.sync();
  assert.equal(v.status, 'active');
  assert.equal(v.redeemedAt, env.clock.now);
  assert.equal(v.expiresAt, env.clock.now + 180 * MIN);
  assert.equal(env.store.data.events.some((e) => e.action === 'redeem'), true);

  env.clock.advance(179 * MIN);
  await env.vouchers.sync();
  assert.equal(v.status, 'active', 'one minute left');
  assert.equal(login().ok, true, 'still connected');

  env.clock.advance(2 * MIN);
  const expiredLogin = login();
  assert.equal(expiredLogin.ok, false, 'router cuts the customer off on its own');
  await env.vouchers.sync();
  assert.equal(v.status, 'expired');
  assert.equal(v.endReason, 'time-up');
  assert.equal((await env.router.listUsers()).length, 0, 'hotspot user cleaned up');
  assert.equal((await env.router.listActive()).length, 0);
});

test('disconnecting and reconnecting does not hand back time past the window', async () => {
  const env = makeEnv();
  const v = await env.vouchers.generate('maria', 60);
  env.router.login({ username: v.code, password: v.code, device: 'phone' });
  await env.vouchers.sync();
  const expires = v.expiresAt;

  env.clock.advance(20 * MIN);
  env.router.logout('phone');
  env.clock.advance(50 * MIN); // away from the router for 50 min; only 20 min of uptime used
  await env.vouchers.sync();
  assert.equal(v.status, 'expired', 'window is wall-clock from first login, even though uptime is only 20 min');
  assert.ok(env.clock.now > expires);
  assert.equal(env.router.login({ username: v.code, password: v.code, device: 'phone' }).ok, false);
});

test('a code works on one device at a time', async () => {
  const env = makeEnv();
  const v = await env.vouchers.generate('maria', 60);
  assert.equal(env.router.login({ username: v.code, password: v.code, device: 'A' }).ok, true);
  const second = env.router.login({ username: v.code, password: v.code, device: 'B' });
  assert.equal(second.ok, false);
  assert.match(second.error, /another device/);
  assert.equal(env.router.login({ username: v.code, password: v.code, device: 'A' }).already, true);
  assert.equal(env.router.login({ username: v.code, password: 'wrong', device: 'A' }).ok, false);
});

test('unredeemed vouchers expire and are removed from the router', async () => {
  const env = makeEnv({ voucher: { unusedExpiryHours: 12 } });
  const v = await env.vouchers.generate('maria', 180);
  env.clock.advance(11 * HOUR);
  await env.vouchers.sync();
  assert.equal(v.status, 'unused');
  env.clock.advance(2 * HOUR);
  await env.vouchers.sync();
  assert.equal(v.status, 'expired');
  assert.equal(v.endReason, 'unredeemed');
  assert.equal((await env.router.listUsers()).length, 0);
  assert.equal(env.router.login({ username: v.code, password: v.code, device: 'x' }).ok, false);
});

test('revoke disconnects the customer and removes the code', async () => {
  const env = makeEnv();
  const v = await env.vouchers.generate('maria', 180);
  env.router.login({ username: v.code, password: v.code, device: 'phone' });
  await env.vouchers.sync();
  assert.equal((await env.router.listActive()).length, 1);

  const revoked = await env.vouchers.revoke(v.id, 'jun');
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.endedBy, 'jun');
  assert.equal((await env.router.listActive()).length, 0);
  assert.equal((await env.router.listUsers()).length, 0);
  assert.equal(env.router.login({ username: v.code, password: v.code, device: 'phone' }).ok, false);
  await assert.rejects(env.vouchers.revoke(v.id, 'jun'), (e) => e.status === 409);
  await assert.rejects(env.vouchers.revoke('deadbeef0000', 'jun'), (e) => e.status === 404);
});

test('router trouble: generating fails cleanly, nothing is recorded', async () => {
  const env = makeEnv();
  env.router.createUser = async () => { throw new Error('connect ECONNREFUSED'); };
  await assert.rejects(env.vouchers.generate('maria', 60), (e) => e.status === 502 && /Couldn't reach the router/.test(e.message));
  assert.equal(env.store.data.vouchers.length, 0);
  assert.equal(env.vouchers.status().ok, false);
  assert.match(env.vouchers.status().lastError, /ECONNREFUSED/);
});

test('router trouble: revoke keeps the voucher live so staff can retry', async () => {
  const env = makeEnv();
  const v = await env.vouchers.generate('maria', 60);
  const original = env.router.removeUser.bind(env.router);
  env.router.removeUser = async () => { throw new Error('timeout'); };
  await assert.rejects(env.vouchers.revoke(v.id, 'maria'), (e) => e.status === 502);
  assert.equal(v.status, 'unused');
  env.router.removeUser = original;
  await env.vouchers.revoke(v.id, 'maria');
  assert.equal(v.status, 'revoked');
});

test('router trouble: sync survives, then catches up when the router returns', async () => {
  const env = makeEnv();
  const v = await env.vouchers.generate('maria', 60);
  env.router.login({ username: v.code, password: v.code, device: 'p' });
  const original = env.router.listUsers.bind(env.router);
  env.router.listUsers = async () => { throw new Error('router down'); };
  await env.vouchers.sync();
  assert.equal(env.vouchers.status().ok, false);
  assert.equal(v.status, 'unused');
  env.router.listUsers = original;
  await env.vouchers.sync();
  assert.equal(env.vouchers.status().ok, true);
  assert.equal(v.status, 'active');
});

test('a failed removal during expiry is retried on the next sync', async () => {
  const env = makeEnv();
  const v = await env.vouchers.generate('maria', 60);
  env.router.login({ username: v.code, password: v.code, device: 'p' });
  await env.vouchers.sync();
  env.clock.advance(61 * MIN);
  const original = env.router.removeUser.bind(env.router);
  env.router.removeUser = async () => { throw new Error('busy'); };
  await env.vouchers.sync();
  assert.equal(v.status, 'active', 'not marked ended while the router still has it');
  env.router.removeUser = original;
  await env.vouchers.sync();
  assert.equal(v.status, 'expired');
});

test('a voucher deleted on the router by hand is marked ended', async () => {
  const env = makeEnv();
  const v = await env.vouchers.generate('maria', 60);
  await env.router.removeUser(v.code);
  await env.vouchers.sync();
  assert.equal(v.status, 'expired');
  assert.equal(v.endReason, 'missing-on-router');
});

test('state survives a restart (store and mock router both persisted)', async () => {
  const env = makeEnv();
  const v = await env.vouchers.generate('maria', 60);
  env.router.login({ username: v.code, password: v.code, device: 'p' });
  await env.vouchers.sync();

  const { Store } = require('../lib/store');
  const { MockRouter } = require('../lib/router-mock');
  const { VoucherService } = require('../lib/vouchers');
  const store2 = new Store(env.config.dataFile).load();
  const router2 = new MockRouter({ stateFile: env.config.router.mockStateFile, clock: env.clock });
  const svc2 = new VoucherService({ store: store2, router: router2, config: env.config, clock: env.clock });
  assert.equal(svc2.list()[0].status, 'active');
  env.clock.advance(30 * MIN);
  await svc2.sync();
  assert.equal(svc2.list()[0].status, 'active');
  env.clock.advance(31 * MIN);
  await svc2.sync();
  assert.equal(svc2.list()[0].status, 'expired');
});

test('old ended vouchers are pruned, live ones never', async () => {
  const env = makeEnv({ keepHistoryDays: 30 });
  const a = await env.vouchers.generate('m', 60);
  const b = await env.vouchers.generate('m', 60);
  await env.vouchers.revoke(a.id, 'm');
  env.clock.advance(31 * 24 * HOUR);
  env.router.createUser({ name: 'KEEPALIVE', password: 'x', limitUptime: '1h', comment: 'x' });
  await env.vouchers.sync();
  let list = env.vouchers.list();
  assert.equal(list.some((v) => v.id === a.id), false, 'revoked voucher past retention is gone');
  const bNow = list.find((v) => v.id === b.id);
  assert.ok(bNow, 'a voucher that only just ended is kept as history');
  assert.equal(bNow.status, 'expired', 'the unused voucher expired (past the unused-expiry window)');

  env.clock.advance(31 * 24 * HOUR);
  await env.vouchers.sync();
  assert.equal(env.vouchers.list().some((v) => v.id === b.id), false, 'and pruned once it is past retention too');
});

test('loginUrl: demo mode points at this app, real mode at the router', async () => {
  const env = makeEnv();
  const url = env.vouchers.loginUrl('ABCD2345', 'http://192.168.1.50:3000');
  assert.equal(url, 'http://192.168.1.50:3000/mock/login?username=ABCD2345&password=ABCD2345');

  const real = makeEnv();
  real.vouchers.router = { mode: 'routeros' };
  real.config.router.loginUrl = 'http://192.168.88.1/login';
  assert.equal(real.vouchers.loginUrl('ABCD2345', 'ignored'), 'http://192.168.88.1/login?username=ABCD2345&password=ABCD2345');
});

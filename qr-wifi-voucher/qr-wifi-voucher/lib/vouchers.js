'use strict';

const crypto = require('node:crypto');
const { parseRosDuration, formatRosDuration } = require('./duration');

// No I, O, 0 or 1: codes get read aloud and typed in by hand.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COMMENT_PREFIX = 'qrwifi:';
const LIVE = new Set(['unused', 'active']);
const MAX_EVENTS = 2000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

class VoucherError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'VoucherError';
    this.status = status;
  }
}

// Voucher life:  unused -> active (first connection seen) -> expired | revoked
//                unused -> expired (nobody used it in time) | revoked
class VoucherService {
  constructor({ store, router, config, clock = Date.now, log = () => {} }) {
    this.store = store;
    this.router = router;
    this.config = config;
    this.clock = clock;
    this.log = log;
    this.health = { ok: null, lastError: null, lastSyncAt: null };
    this.syncing = false;
  }

  status() {
    return { mode: this.router.mode, ok: this.health.ok, lastError: this.health.lastError, lastSyncAt: this.health.lastSyncAt };
  }

  list() {
    return [...this.store.data.vouchers].sort((a, b) => b.createdAt - a.createdAt).slice(0, 300);
  }

  loginUrl(code, origin) {
    const base = this.router.mode === 'mock' ? `${origin}/mock/login` : this.config.router.loginUrl;
    const url = new URL(base);
    url.searchParams.set('username', code);
    url.searchParams.set('password', code);
    return url.toString();
  }

  #newCode() {
    let code = '';
    for (let i = 0; i < this.config.voucher.codeLength; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    return code;
  }

  #event(action, user, voucher) {
    const events = this.store.data.events;
    events.push({ at: this.clock(), user, action, voucherId: voucher.id, code: voucher.code });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  }

  #end(voucher, status, reason, endedBy = null) {
    voucher.status = status;
    voucher.endedAt = this.clock();
    voucher.endReason = reason;
    voucher.endedBy = endedBy;
    this.#event(status === 'revoked' ? 'revoke' : 'expire', endedBy, voucher);
  }

  #routerFailed(err) {
    this.health = { ok: false, lastError: err && err.message ? err.message : String(err), lastSyncAt: this.health.lastSyncAt };
    this.log(`router error: ${this.health.lastError}`);
  }

  async generate(staffName, durationMinutes) {
    const cfg = this.config.voucher;
    const minutes = durationMinutes == null ? cfg.durationMinutes : durationMinutes;
    if (!Number.isInteger(minutes) || !cfg.durationOptionsMinutes.includes(minutes)) {
      throw new VoucherError(400, 'Pick one of the listed durations.');
    }
    const vouchers = this.store.data.vouchers;
    const unused = vouchers.filter((v) => v.status === 'unused').length;
    if (unused >= cfg.maxUnused) {
      throw new VoucherError(429, `There are already ${unused} unused vouchers. Revoke some, or wait for them to expire.`);
    }

    const taken = new Set(vouchers.filter((v) => LIVE.has(v.status)).map((v) => v.code));
    let code;
    do {
      code = this.#newCode();
    } while (taken.has(code));

    const id = crypto.randomBytes(6).toString('hex');
    let created;
    try {
      created = await this.router.createUser({
        name: code,
        password: code,
        limitUptime: formatRosDuration(minutes * 60),
        comment: COMMENT_PREFIX + id,
      });
    } catch (err) {
      this.#routerFailed(err);
      if (err && err.status) {
        throw new VoucherError(502, `The router refused to create the voucher (${err.detail || err.message}).`);
      }
      throw new VoucherError(502, "Couldn't reach the router, so no voucher was created. Try again in a moment.");
    }
    this.health = { ok: true, lastError: null, lastSyncAt: this.health.lastSyncAt };

    const voucher = {
      id,
      code,
      status: 'unused',
      durationMinutes: minutes,
      createdAt: this.clock(),
      createdBy: staffName,
      redeemedAt: null,
      expiresAt: null,
      endedAt: null,
      endReason: null,
      endedBy: null,
      routerUserId: created && created.id ? created.id : null,
    };
    vouchers.push(voucher);
    this.#event('generate', staffName, voucher);
    try {
      this.store.save();
    } catch (err) {
      vouchers.pop();
      this.store.data.events.pop();
      try {
        await this.router.removeUser(code, voucher.routerUserId);
      } catch {
        // best effort: the unused-voucher cleanup would not find it, but it can't be redeemed from the app either
      }
      this.log(`could not save voucher: ${err.message}`);
      throw new VoucherError(500, 'Could not save the voucher. Check disk space and permissions on the data folder.');
    }
    return voucher;
  }

  async revoke(id, staffName) {
    const voucher = this.store.data.vouchers.find((v) => v.id === id);
    if (!voucher) throw new VoucherError(404, 'Voucher not found.');
    if (!LIVE.has(voucher.status)) throw new VoucherError(409, 'That voucher has already ended.');
    try {
      await this.router.removeUser(voucher.code, voucher.routerUserId);
    } catch (err) {
      this.#routerFailed(err);
      throw new VoucherError(502, "Couldn't reach the router, so the voucher is still active. Try again.");
    }
    this.#end(voucher, 'revoked', 'revoked', staffName);
    this.store.save();
    return voucher;
  }

  // Compares our records with the router: notices first connections, enforces the
  // time window (which starts at first connection), and cleans up finished vouchers.
  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      let users;
      let sessions;
      try {
        [users, sessions] = await Promise.all([this.router.listUsers(), this.router.listActive()]);
      } catch (err) {
        this.#routerFailed(err);
        return;
      }
      const now = this.clock();
      this.health = { ok: true, lastError: null, lastSyncAt: now };

      const byName = new Map(users.map((u) => [u.name, u]));
      const liveSessions = new Map();
      for (const s of sessions) {
        if (!liveSessions.has(s.user)) liveSessions.set(s.user, []);
        liveSessions.get(s.user).push(s);
      }

      const cfg = this.config.voucher;
      let dirty = false;
      for (const v of this.store.data.vouchers) {
        if (!LIVE.has(v.status)) continue;
        const user = byName.get(v.code);
        if (!user) {
          this.#end(v, 'expired', 'missing-on-router');
          dirty = true;
          continue;
        }
        const usedMs = parseRosDuration(user.uptime) * 1000;
        const connected = (liveSessions.get(v.code) || []).length > 0;

        if (v.status === 'unused' && (usedMs > 0 || connected)) {
          v.status = 'active';
          v.redeemedAt = Math.max(v.createdAt, now - usedMs);
          v.expiresAt = v.redeemedAt + v.durationMinutes * 60_000;
          this.#event('redeem', null, v);
          dirty = true;
        }

        let reason = null;
        if (v.status === 'active') {
          if (now >= v.expiresAt || usedMs >= v.durationMinutes * 60_000) reason = 'time-up';
        } else if (now >= v.createdAt + cfg.unusedExpiryHours * HOUR) {
          reason = 'unredeemed';
        }
        if (reason) {
          try {
            await this.router.removeUser(v.code, v.routerUserId);
          } catch (err) {
            this.#routerFailed(err);
            continue; // try again next round; the router's own limit-uptime still applies meanwhile
          }
          this.#end(v, 'expired', reason);
          dirty = true;
        }
      }

      const cutoff = now - this.config.keepHistoryDays * DAY;
      const kept = this.store.data.vouchers.filter((v) => LIVE.has(v.status) || (v.endedAt || v.createdAt) >= cutoff);
      if (kept.length !== this.store.data.vouchers.length) {
        this.store.data.vouchers = kept;
        dirty = true;
      }
      if (dirty) this.store.save();
    } finally {
      this.syncing = false;
    }
  }
}

module.exports = { VoucherService, VoucherError, ALPHABET, COMMENT_PREFIX };

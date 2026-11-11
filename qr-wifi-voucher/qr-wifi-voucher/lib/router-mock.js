'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { formatRosDuration } = require('./duration');

const COMMENT_PREFIX = 'qrwifi:';

// A pretend MikroTik hotspot. It behaves like the real thing as far as this app cares:
// hotspot users with limit-uptime, one active session per user (shared-users=1),
// and uptime that stops the user logging in once the limit is used up.
// State is kept in a JSON file so a restart of the app doesn't forget the vouchers.
class MockRouter {
  constructor({ stateFile = null, clock = Date.now } = {}) {
    this.mode = 'mock';
    this.stateFile = stateFile;
    this.clock = clock;
    this.users = {};
    this.nextId = 1;
    this.#load();
  }

  #load() {
    if (!this.stateFile) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.users = s.users && typeof s.users === 'object' ? s.users : {};
      this.nextId = Number.isInteger(s.nextId) ? s.nextId : 1;
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[mock-router] ignoring unreadable ${this.stateFile}: ${err.message}`);
    }
  }

  #persist() {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users, nextId: this.nextId }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  #newId(prefix) {
    return `*${prefix}${(this.nextId++).toString(16).toUpperCase()}`;
  }

  #rawUptime(user, now) {
    let total = user.accruedSec;
    for (const s of user.sessions) total += (now - s.startedMs) / 1000;
    return total;
  }

  // The real router stops a user once limit-uptime is used up; do the same on every read.
  #enforce(now) {
    let changed = false;
    for (const u of Object.values(this.users)) {
      if (u.sessions.length > 0 && this.#rawUptime(u, now) >= u.limitUptimeSec) {
        u.accruedSec = u.limitUptimeSec;
        u.sessions = [];
        changed = true;
      }
    }
    if (changed) this.#persist();
  }

  async ping() {
    return { ok: true, identity: 'mock-router' };
  }

  async createUser({ name, password, limitUptime, comment }) {
    const { parseRosDuration } = require('./duration');
    if (this.users[name]) {
      const err = new Error('failure: already have such user');
      err.status = 400;
      throw err;
    }
    const id = this.#newId('U');
    this.users[name] = {
      id, name, password, comment: comment || '',
      limitUptimeSec: parseRosDuration(limitUptime),
      accruedSec: 0,
      sessions: [],
    };
    this.#persist();
    return { id };
  }

  async listUsers() {
    const now = this.clock();
    this.#enforce(now);
    return Object.values(this.users)
      .filter((u) => u.comment.startsWith(COMMENT_PREFIX))
      .map((u) => ({
        id: u.id,
        name: u.name,
        uptime: formatRosDuration(this.#rawUptime(u, now)),
        limitUptime: formatRosDuration(u.limitUptimeSec),
        comment: u.comment,
        disabled: false,
      }));
  }

  async listActive() {
    const now = this.clock();
    this.#enforce(now);
    const out = [];
    for (const u of Object.values(this.users)) {
      for (const s of u.sessions) {
        out.push({
          id: s.id,
          user: u.name,
          address: '10.5.50.10',
          macAddress: s.device,
          uptime: formatRosDuration((now - s.startedMs) / 1000),
        });
      }
    }
    return out;
  }

  #closeSessions(user, now, onlyDevice = null) {
    let closed = 0;
    user.sessions = user.sessions.filter((s) => {
      if (onlyDevice && s.device !== onlyDevice) return true;
      user.accruedSec += (now - s.startedMs) / 1000;
      closed += 1;
      return false;
    });
    return closed;
  }

  async kick(name) {
    const u = this.users[name];
    if (u && this.#closeSessions(u, this.clock()) > 0) this.#persist();
  }

  async removeUser(name) {
    // Idempotent, like deleting something that is already gone.
    if (this.users[name]) {
      delete this.users[name];
      this.#persist();
    }
  }

  // --- what the hotspot login page does (used by the demo portal in the app) ---

  login({ username, password, device }) {
    const now = this.clock();
    this.#enforce(now);
    const u = this.users[username];
    if (!u || u.password !== password) return { ok: false, error: 'That voucher code is not valid.' };
    const used = this.#rawUptime(u, now);
    if (used >= u.limitUptimeSec) return { ok: false, error: 'This voucher has used up its time.' };
    const existing = u.sessions.find((s) => s.device === device);
    if (!existing && u.sessions.length >= 1) {
      return { ok: false, error: 'This voucher is already in use on another device.' };
    }
    if (!existing) {
      u.sessions.push({ id: this.#newId('S'), device, startedMs: now });
      this.#persist();
    }
    return { ok: true, already: Boolean(existing), remainingSec: Math.max(0, u.limitUptimeSec - this.#rawUptime(u, now)) };
  }

  logout(device) {
    const now = this.clock();
    let closed = 0;
    for (const u of Object.values(this.users)) closed += this.#closeSessions(u, now, device);
    if (closed > 0) this.#persist();
    return closed;
  }
}

module.exports = { MockRouter, COMMENT_PREFIX };

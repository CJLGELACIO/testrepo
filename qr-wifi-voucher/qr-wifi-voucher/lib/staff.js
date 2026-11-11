'use strict';

const fs = require('node:fs');
const { writeFileAtomic } = require('./store');

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

function normalizeUsername(name) {
  return String(name || '').trim().toLowerCase();
}

function validUsername(name) {
  return USERNAME_RE.test(normalizeUsername(name));
}

// Staff accounts: { users: { alice: { hash, createdAt } } }
// Re-read whenever the file changes, so `node manage.js ...` takes effect without a restart,
// and a removed account loses access immediately.
class StaffFile {
  constructor(file) {
    this.file = file;
    this.cache = { users: {} };
    this.signature = null;
  }

  #read() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.cache = { users: {} };
        this.signature = null;
        return this.cache;
      }
      throw err;
    }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (sig !== this.signature) {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.cache = { users: parsed && typeof parsed.users === 'object' && parsed.users ? parsed.users : {} };
      this.cache = { users: this.cache.users };
      this.signature = sig;
    }
    return this.cache;
  }

  get(name) {
    const users = this.#read().users;
    const key = normalizeUsername(name);
    return Object.prototype.hasOwnProperty.call(users, key) ? { username: key, ...users[key] } : null;
  }

  list() {
    return Object.entries(this.#read().users).map(([username, u]) => ({ username, createdAt: u.createdAt || null }));
  }

  count() {
    return Object.keys(this.#read().users).length;
  }

  set(name, hash) {
    const key = normalizeUsername(name);
    if (!validUsername(key)) throw new Error('Usernames are 2-32 characters: letters, numbers, dot, dash, underscore.');
    const users = { ...this.#read().users };
    const existing = users[key];
    users[key] = { hash, createdAt: existing && existing.createdAt ? existing.createdAt : Date.now() };
    writeFileAtomic(this.file, JSON.stringify({ users }, null, 2));
    this.signature = null;
  }

  remove(name) {
    const key = normalizeUsername(name);
    const users = { ...this.#read().users };
    if (!Object.prototype.hasOwnProperty.call(users, key)) return false;
    delete users[key];
    writeFileAtomic(this.file, JSON.stringify({ users }, null, 2));
    this.signature = null;
    return true;
  }
}

module.exports = { StaffFile, validUsername, normalizeUsername };

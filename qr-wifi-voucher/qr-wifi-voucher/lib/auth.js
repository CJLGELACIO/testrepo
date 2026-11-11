'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_PASSWORD = 200;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password).slice(0, MAX_PASSWORD), salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p,
  });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (expected.length === 0) return false;
  const key = await scryptAsync(password.slice(0, MAX_PASSWORD), salt, expected.length, {
    N, r, p, maxmem: 256 * N * r,
  });
  return crypto.timingSafeEqual(key, expected);
}

// Verified against when the username doesn't exist, so response time doesn't reveal valid usernames.
const DUMMY_HASH = hashPassword('not-a-real-password');

class Sessions {
  constructor(ttlMs, clock = Date.now) {
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.map = new Map();
  }

  #key(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  create(username) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.#prune();
    this.map.set(this.#key(token), { username, expires: this.clock() + this.ttlMs });
    return token;
  }

  get(token) {
    if (!token) return null;
    const key = this.#key(token);
    const session = this.map.get(key);
    if (!session) return null;
    if (session.expires <= this.clock()) {
      this.map.delete(key);
      return null;
    }
    return session;
  }

  destroy(token) {
    if (token) this.map.delete(this.#key(token));
  }

  #prune() {
    const now = this.clock();
    for (const [key, s] of this.map) if (s.expires <= now) this.map.delete(key);
  }
}

// Counts failures per key; after `max` failures inside the window, the key is locked for lockMs.
class LoginLimiter {
  constructor({ maxFailures = 5, windowMs = 15 * 60_000, lockMs = 5 * 60_000, clock = Date.now } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.clock = clock;
    this.map = new Map();
  }

  check(key) {
    const entry = this.map.get(key);
    const now = this.clock();
    if (entry && entry.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  fail(key, max = this.maxFailures) {
    const now = this.clock();
    let entry = this.map.get(key);
    if (!entry || now - entry.first > this.windowMs) entry = { count: 0, first: now, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= max) {
      entry.lockedUntil = now + this.lockMs;
      entry.count = 0;
      entry.first = now;
    }
    this.map.set(key, entry);
    if (this.map.size > 5000) this.#prune(now);
  }

  success(key) {
    this.map.delete(key);
  }

  #prune(now) {
    for (const [key, e] of this.map) {
      if (e.lockedUntil <= now && now - e.first > this.windowMs) this.map.delete(key);
    }
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, Sessions, LoginLimiter, parseCookies, MAX_PASSWORD };

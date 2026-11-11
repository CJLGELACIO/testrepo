'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  cafeName: 'My Cafe',
  wifiName: 'Cafe Guest WiFi',
  port: 3000,
  host: '0.0.0.0',
  dataFile: 'data/store.json',
  staffFile: 'data/staff.json',
  cookieSecure: false,
  sessionHours: 12,
  syncIntervalSeconds: 10,
  keepHistoryDays: 30,
  voucher: {
    durationMinutes: 180,
    durationOptionsMinutes: [60, 120, 180],
    unusedExpiryHours: 12,
    maxUnused: 100,
    codeLength: 8,
  },
  router: {
    mode: 'mock',
    url: 'https://192.168.88.1',
    username: 'qrwifi-api',
    password: '',
    caFile: '',
    insecureSkipVerify: false,
    profile: 'qrwifi',
    server: '',
    loginUrl: '',
    mockStateFile: 'data/mock-router.json',
  },
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validate(cfg) {
  const problems = [];
  const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

  if (!int(cfg.port, 1, 65535)) problems.push('port must be a whole number from 1 to 65535');
  if (!(typeof cfg.sessionHours === 'number' && cfg.sessionHours > 0)) problems.push('sessionHours must be greater than 0');
  if (!int(cfg.syncIntervalSeconds, 2, 3600)) problems.push('syncIntervalSeconds must be a whole number from 2 to 3600');
  if (!int(cfg.keepHistoryDays, 1, 3650)) problems.push('keepHistoryDays must be a whole number from 1 to 3650');

  const v = cfg.voucher;
  if (!Array.isArray(v.durationOptionsMinutes) || v.durationOptionsMinutes.length === 0 ||
      !v.durationOptionsMinutes.every((m) => int(m, 1, 1440))) {
    problems.push('voucher.durationOptionsMinutes must be a list of whole minutes, each from 1 to 1440');
  } else if (!int(v.durationMinutes, 1, 1440)) {
    problems.push('voucher.durationMinutes must be a whole number of minutes from 1 to 1440');
  } else if (!v.durationOptionsMinutes.includes(v.durationMinutes)) {
    v.durationOptionsMinutes = [...v.durationOptionsMinutes, v.durationMinutes].sort((a, b) => a - b);
  }
  if (!int(v.unusedExpiryHours, 1, 720)) problems.push('voucher.unusedExpiryHours must be a whole number from 1 to 720');
  if (!int(v.maxUnused, 1, 5000)) problems.push('voucher.maxUnused must be a whole number from 1 to 5000');
  if (!int(v.codeLength, 6, 16)) problems.push('voucher.codeLength must be a whole number from 6 to 16');

  const r = cfg.router;
  if (r.mode !== 'mock' && r.mode !== 'routeros') {
    problems.push('router.mode must be "mock" or "routeros"');
  } else if (r.mode === 'routeros') {
    if (!isHttpUrl(r.url)) problems.push('router.url must be an http:// or https:// address');
    if (!r.username) problems.push('router.username is required in routeros mode');
    if (!r.password) problems.push('router.password is required in routeros mode (or set the ROUTER_PASSWORD environment variable)');
    if (!isHttpUrl(r.loginUrl)) problems.push('router.loginUrl must be the hotspot login address, e.g. http://192.168.88.1/login');
    if (!r.profile) problems.push('router.profile is required in routeros mode');
    if (r.caFile && !fs.existsSync(r.caFile)) problems.push(`router.caFile not found: ${r.caFile}`);
  }

  if (problems.length) {
    throw new Error('Invalid configuration:\n  - ' + problems.join('\n  - '));
  }
}

function loadConfig(file) {
  const configPath = file || process.env.QRWIFI_CONFIG || path.join(ROOT, 'config.json');
  let user = {};
  let source = 'built-in defaults (no config.json found, running in demo mode)';
  if (fs.existsSync(configPath)) {
    try {
      user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      source = configPath;
    } catch (err) {
      throw new Error(`Could not read ${configPath}: ${err.message}`);
    }
  }
  const cfg = merge(DEFAULTS, user);
  if (process.env.ROUTER_PASSWORD) cfg.router.password = process.env.ROUTER_PASSWORD;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);

  cfg.dataFile = path.resolve(ROOT, cfg.dataFile);
  cfg.staffFile = path.resolve(ROOT, cfg.staffFile);
  cfg.router.mockStateFile = path.resolve(ROOT, cfg.router.mockStateFile);
  if (cfg.router.caFile) cfg.router.caFile = path.resolve(ROOT, cfg.router.caFile);

  validate(cfg);
  cfg.configSource = source;
  return cfg;
}

module.exports = { loadConfig, validate, merge, DEFAULTS, ROOT };

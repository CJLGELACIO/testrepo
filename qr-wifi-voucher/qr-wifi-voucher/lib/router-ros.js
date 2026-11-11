'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const COMMENT_PREFIX = 'qrwifi:';

// Talks to a real MikroTik through the RouterOS v7 REST API (https://<router>/rest/...).
// Needs RouterOS 7.1 or newer with the `www` (http) or `www-ssl` (https) service enabled.
class RouterOsRouter {
  constructor(cfg) {
    this.mode = 'routeros';
    this.url = new URL(cfg.url);
    this.auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    this.profile = cfg.profile;
    this.server = cfg.server || '';
    this.timeoutMs = cfg.timeoutMs || 8000;

    const secure = this.url.protocol === 'https:';
    this.lib = secure ? https : http;
    const agentOptions = { keepAlive: true, maxSockets: 4 };
    if (secure) {
      agentOptions.rejectUnauthorized = !cfg.insecureSkipVerify;
      if (cfg.caFile) agentOptions.ca = fs.readFileSync(cfg.caFile);
    }
    this.agent = new this.lib.Agent(agentOptions);
  }

  request(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = { Authorization: this.auth, Accept: 'application/json' };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      const req = this.lib.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname.replace(/^\[|\]$/g, ''),
          port: this.url.port || undefined,
          method,
          path: `${this.url.pathname.replace(/\/+$/, '')}/rest${apiPath}`,
          agent: this.agent,
          timeout: this.timeoutMs,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let data = null;
            if (text) {
              try {
                data = JSON.parse(text);
              } catch {
                data = null;
              }
            }
            if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
            const detail = data && (data.detail || data.message);
            const err = new Error(`RouterOS ${res.statusCode}: ${detail || res.statusMessage || 'error'}`);
            err.status = res.statusCode;
            err.detail = detail || null;
            reject(err);
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('RouterOS request timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async ping() {
    const identity = await this.request('GET', '/system/identity');
    return { ok: true, identity: identity && identity.name };
  }

  async createUser({ name, password, limitUptime, comment }) {
    const body = {
      name,
      password,
      profile: this.profile,
      'limit-uptime': limitUptime,
      comment,
    };
    if (this.server) body.server = this.server;
    const created = await this.request('PUT', '/ip/hotspot/user', body);
    return { id: created && created['.id'] ? created['.id'] : null };
  }

  async listUsers() {
    const rows = (await this.request('GET', '/ip/hotspot/user')) || [];
    return rows
      .filter((u) => typeof u.comment === 'string' && u.comment.startsWith(COMMENT_PREFIX))
      .map((u) => ({
        id: u['.id'],
        name: u.name,
        uptime: u.uptime || '0s',
        limitUptime: u['limit-uptime'] || '',
        comment: u.comment,
        disabled: u.disabled === 'true' || u.disabled === true,
      }));
  }

  async listActive() {
    const rows = (await this.request('GET', '/ip/hotspot/active')) || [];
    return rows.map((a) => ({
      id: a['.id'],
      user: a.user,
      address: a.address,
      macAddress: a['mac-address'],
      uptime: a.uptime || '0s',
    }));
  }

  async #deleteQuietly(apiPath) {
    try {
      await this.request('DELETE', apiPath);
    } catch (err) {
      if (err.status !== 404) throw err; // already gone is fine
    }
  }

  async kick(name) {
    const active = await this.listActive();
    for (const a of active.filter((x) => x.user === name)) {
      await this.#deleteQuietly(`/ip/hotspot/active/${a.id}`);
    }
  }

  // Disconnects the user's session(s) first, then deletes the hotspot user.
  async removeUser(name, id) {
    await this.kick(name);
    let userId = id;
    if (!userId) {
      const match = (await this.listUsers()).find((u) => u.name === name);
      if (!match) return;
      userId = match.id;
    }
    await this.#deleteQuietly(`/ip/hotspot/user/${userId}`);
  }
}

module.exports = { RouterOsRouter, COMMENT_PREFIX };

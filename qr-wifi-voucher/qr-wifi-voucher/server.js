#!/usr/bin/env node
'use strict';

const http = require('node:http');
const os = require('node:os');
const { loadConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const { StaffFile } = require('./lib/staff');
const { Sessions, LoginLimiter } = require('./lib/auth');
const { MockRouter } = require('./lib/router-mock');
const { RouterOsRouter } = require('./lib/router-ros');
const { VoucherService } = require('./lib/vouchers');
const { createApp } = require('./lib/app');

function stamp() {
  return new Date().toLocaleTimeString();
}
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const store = new Store(config.dataFile).load();
  const staff = new StaffFile(config.staffFile);
  const router = config.router.mode === 'mock'
    ? new MockRouter({ stateFile: config.router.mockStateFile })
    : new RouterOsRouter(config.router);
  const vouchers = new VoucherService({ store, router, config, log });
  const sessions = new Sessions(config.sessionHours * 3_600_000);
  const limiter = new LoginLimiter();
  const app = createApp({ config, store, staff, router, vouchers, sessions, limiter, log });

  const server = http.createServer((req, res) => {
    app.handle(req, res).catch((err) => {
      log(`request failed: ${err && err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Change "port" in config.json or stop the other program.`);
    else console.error(err.message);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    console.log('');
    console.log(`  ${config.cafeName}: QR Wi-Fi vouchers`);
    console.log(`  Config: ${config.configSource}`);
    console.log(`  Router: ${config.router.mode === 'mock' ? 'MOCK (demo mode, no real router)' : config.router.url}`);
    console.log('  Open the staff page at:');
    console.log(`    http://localhost:${config.port}`);
    for (const ip of lanAddresses()) console.log(`    http://${ip}:${config.port}`);
    if (staff.count() === 0) {
      console.log('');
      console.log('  No staff accounts yet. Create one in another terminal:');
      console.log('    node manage.js add-staff <username>');
    }
    console.log('');
  });

  let syncing = false;
  const runSync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      await vouchers.sync();
    } catch (err) {
      log(`sync failed: ${err.message}`);
    } finally {
      syncing = false;
    }
  };
  runSync();
  setInterval(runSync, config.syncIntervalSeconds * 1000);

  const shutdown = () => {
    log('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();

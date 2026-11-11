'use strict';

const fs = require('node:fs');
const path = require('node:path');

function emptyData() {
  return { version: 1, vouchers: [], events: [] };
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Voucher + audit data. Owned by the running server only.
// (Staff accounts live in their own file so the CLI can edit them while the server runs.)
class Store {
  constructor(file) {
    this.file = file;
    this.data = emptyData();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return this;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Data file ${this.file} is not valid JSON (${err.message}). It has not been overwritten; fix or move it aside.`);
    }
    this.data = { ...emptyData(), ...parsed };
    if (!Array.isArray(this.data.vouchers)) this.data.vouchers = [];
    if (!Array.isArray(this.data.events)) this.data.events = [];
    return this;
  }

  save() {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { Store, writeFileAtomic };

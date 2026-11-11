#!/usr/bin/env node
'use strict';

// Staff accounts for the voucher page.
//   node manage.js add-staff <username>
//   node manage.js set-password <username>
//   node manage.js remove-staff <username>
//   node manage.js list-staff
// Works while the server is running. For scripts, set QRWIFI_PASSWORD instead of typing the password.

const { loadConfig } = require('./lib/config');
const { StaffFile, validUsername, normalizeUsername } = require('./lib/staff');
const { hashPassword, MAX_PASSWORD } = require('./lib/auth');

const USAGE = `Usage:
  node manage.js add-staff <username>
  node manage.js set-password <username>
  node manage.js remove-staff <username>
  node manage.js list-staff`;

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      if (chunk.startsWith('\u001b')) return; // arrow keys and the like
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readLineFromStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

async function askPassword() {
  if (process.env.QRWIFI_PASSWORD) return process.env.QRWIFI_PASSWORD;
  if (!process.stdin.isTTY) return readLineFromStdin();
  const first = await readHidden('New password (at least 8 characters): ');
  const second = await readHidden('Type it again: ');
  if (first !== second) throw new Error('The two passwords did not match. Nothing was changed.');
  return first;
}

function checkPassword(pw) {
  if (pw.length < 8) throw new Error('Password must be at least 8 characters.');
  if (pw.length > MAX_PASSWORD) throw new Error(`Password must be at most ${MAX_PASSWORD} characters.`);
}

async function main(argv) {
  const [command, rawName] = argv;
  const config = loadConfig();
  const staff = new StaffFile(config.staffFile);
  const name = normalizeUsername(rawName);

  switch (command) {
    case 'add-staff': {
      if (!rawName) throw new Error(USAGE);
      if (!validUsername(name)) throw new Error('Usernames are 2-32 characters: letters, numbers, dot, dash, underscore.');
      if (staff.get(name)) throw new Error(`"${name}" already exists. Use set-password to change their password.`);
      const pw = await askPassword();
      checkPassword(pw);
      staff.set(name, hashPassword(pw));
      console.log(`Added staff account "${name}".`);
      return;
    }
    case 'set-password': {
      if (!rawName) throw new Error(USAGE);
      if (!staff.get(name)) throw new Error(`No staff account named "${name}".`);
      const pw = await askPassword();
      checkPassword(pw);
      staff.set(name, hashPassword(pw));
      console.log(`Password changed for "${name}".`);
      return;
    }
    case 'remove-staff': {
      if (!rawName) throw new Error(USAGE);
      if (!staff.remove(name)) throw new Error(`No staff account named "${name}".`);
      console.log(`Removed "${name}". Their open sessions stop working right away.`);
      return;
    }
    case 'list-staff': {
      const rows = staff.list();
      if (rows.length === 0) console.log('No staff accounts yet. Add one with: node manage.js add-staff <username>');
      for (const r of rows) console.log(`${r.username}  (added ${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : 'unknown'})`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});

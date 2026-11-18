// wizard-troubleshooter#37 (17 Nov 2026): a box's interface container mounted an older pinned security policy over
// the release's own. The shell then could neither frame nor ping this page's own line (:9691), so Open
// Troubleshooter showed Connection help, while every check here said All working. This check names it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-direct-line-'));
const RELEASE = "default-src 'self'; connect-src 'self' blob: https://derp1.tailscale.com/generate_204 https://*.ts.net:9691; frame-src 'self' blob: https://*.ts.net:9691; object-src 'none'";
const PINNED = "default-src 'self'; script-src 'self'; connect-src 'self' https://derp1.tailscale.com/generate_204; object-src 'none'";
let csp = RELEASE;
const shell = http.createServer((req, res) => { res.setHeader('Content-Security-Policy', csp); res.end('<!doctype html>'); });
await new Promise(r => shell.listen(0, '127.0.0.1', r));
// A fake docker that reports the pinned bind mount over the image's own policy file.
const docker = path.join(state, 'docker');
fs.writeFileSync(docker, `#!/bin/sh\necho '[{"Type":"bind","Source":"/srv/pinned/primary-static.conf","Destination":"/etc/wizard-shell/static.conf"},{"Type":"bind","Source":"/srv/web","Destination":"/usr/share/nginx/wizard-ux"}]'\n`, { mode: 0o755 });
Object.assign(process.env, { HOME: state, TROUBLESHOOT_STATE: state, SHELL_PORT: String(shell.address().port), SHELL_PATH: '/wizard-os-home/', SHELL_CONTAINER: 'fake-shell', DOCKER_BIN: docker, TS_SOCKET: path.join(state, 'no.sock'), APP_ADDRESSES: '0', RUN_KEEPER_UNIT: '' });
const { CHECKS, directLineGaps } = await import('../lib/checks.mjs');
const check = CHECKS.find(c => c.id === 'shell-direct-line');
test.after(() => shell.close());

test('the release policy allows framing and pinging the own line', async () => {
  assert.deepEqual(directLineGaps(RELEASE), []);
  assert.deepEqual(directLineGaps("default-src 'self'; frame-src https://box.example.ts.net:9691; connect-src https://box.example.ts.net:9691"), []);
  assert.deepEqual(directLineGaps(''), [], 'no policy header blocks nothing');
  csp = RELEASE;
  const r = await check.probe();
  assert.equal(r.ok, true, r.detail);
});

// owner-correction: humanitylabs-org/wizard-troubleshooter#37 · 2026-11-08 · "The troubleshooter needs the capacity to fix the system when it's broken. That's its sole purpose."
test('an older pinned policy without the own line fails and names the mount', async () => {
  assert.deepEqual(directLineGaps(PINNED), ['opening', 'checking']);
  assert.deepEqual(directLineGaps("default-src 'self'; frame-src https://*.ts.net:8444"), ['opening', 'checking'], 'only port 9691 is the own line');
  csp = PINNED;
  const r = await check.probe();
  assert.equal(r.ok, false);
  assert.match(r.detail, /older security policy/);
  assert.match(r.detail, /Connection help/);
  assert.match(r.detail, /\/srv\/pinned\/primary-static\.conf/);
  assert.equal(check.noAutoFix, true, 'the guardian never restarts anything for it');
});

test('a shell that is down is left to the shell check', async () => {
  process.env.SHELL_PORT = '1';
  const { CONFIG } = await import('../lib/checks.mjs');
  const old = CONFIG.shellPort; CONFIG.shellPort = 1;
  try { assert.equal((await check.probe()).ok, true); } finally { CONFIG.shellPort = old; }
});

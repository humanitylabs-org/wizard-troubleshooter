// node --test tests/  — focused checks for the Troubleshooter service and the Guardian.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NODE = process.execPath;
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-test-'));

async function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(NODE, [path.join(APP, 'server.mjs')], { env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/troubleshoot/api/ping`); return { port, child }; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  child.kill(); throw new Error('server did not start');
}

test('owner gate: ping is open, everything else needs a real tailnet peer', async () => {
  const state = tmp();
  const { port, child } = await startServer({ TROUBLESHOOT_STATE: state, TS_SOCKET: path.join(state, 'no.sock') });
  try {
    const B = `http://127.0.0.1:${port}/troubleshoot`;
    assert.equal((await fetch(`${B}/api/ping`)).status, 200);
    assert.equal((await fetch(`${B}/api/status`)).status, 403, 'no peer header');
    assert.equal((await fetch(`${B}/api/status`, { headers: { 'X-Private-Peer': '8.8.8.8' } })).status, 403, 'non-tailnet peer');
    assert.equal((await fetch(`${B}/api/status`, { headers: { 'X-Private-Peer': '100.64.0.9' } })).status, 403, 'tailnet IP that whois cannot confirm');
    assert.equal((await fetch(`${B}/`)).status, 403);
  } finally { child.kill(); }
});

test('guardian endpoint needs loopback, no forwarded headers, and the exact token', async () => {
  const state = tmp();
  const { port, child } = await startServer({ TROUBLESHOOT_STATE: state, CLAUDE_BIN: '/bin/false', CODEX_BIN: '/bin/false' });
  try {
    const url = `http://127.0.0.1:${port}/troubleshoot/api/guardian-repair`;
    const post = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ message: 'test' }) });
    assert.equal((await post({ 'X-Guardian-Token': 'nope' })).status, 403);
    const token = fs.readFileSync(path.join(state, 'guardian.token'), 'utf8').trim();
    assert.equal((await post({ 'X-Guardian-Token': token, 'X-Private-Peer': '100.64.0.9' })).status, 403, 'request that came through the gateway');
    assert.equal((await post({ 'X-Guardian-Token': token, 'X-Forwarded-For': '1.2.3.4' })).status, 403);
    const ok = await post({ 'X-Guardian-Token': token });
    assert.equal(ok.status, 202);
    const { id } = await ok.json();
    // Both engines fail (/bin/false): the conversation must close honestly instead of hanging.
    let conv;
    for (let i = 0; i < 40; i++) { conv = JSON.parse(fs.readFileSync(path.join(state, 'conversations', `${id}.json`), 'utf8')); if (!conv.running) break; await new Promise(r => setTimeout(r, 100)); }
    assert.equal(conv.running, false);
    assert.ok(conv.events.some(e => e.type === 'note' && /Trying ChatGPT/.test(e.text)), 'falls back from Claude to ChatGPT');
    assert.equal(conv.events.at(-1).type, 'end');
  } finally { child.kill(); }
});

test('state-changing requests refuse other origins', async () => {
  const state = tmp();
  const { port, child } = await startServer({ TROUBLESHOOT_STATE: state, TROUBLESHOOT_DEV_NO_AUTH: '1' });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/troubleshoot/api/action`, { method: 'POST', body: JSON.stringify({ action: 'restart:hermes' }) });
    assert.equal(r.status, 403, 'missing X-Wizard-Troubleshoot header');
    const bad = await fetch(`http://127.0.0.1:${port}/troubleshoot/api/action`, { method: 'POST', headers: { 'X-Wizard-Troubleshoot': '1' }, body: JSON.stringify({ action: 'rm -rf /' }) });
    assert.equal(bad.status, 400, 'only named actions exist');
  } finally { child.kill(); }
});

test('guardian waits for consecutive failures before acting', () => {
  const state = tmp();
  const env = { ...process.env, TROUBLESHOOT_STATE: state, AGENT_PORT: '1', HERMES_PORT: '2', SHELL_PORT: '3' };
  const runG = () => execFileSync(NODE, [path.join(APP, 'bin/guardian.mjs'), '--dry-run'], { env, encoding: 'utf8' });
  const first = runG();
  assert.doesNotMatch(first, /would/, 'one failed check is not enough');
  const second = runG();
  assert.match(second, /would restart:shell/, 'shell restarts after 2 failures');
  assert.doesNotMatch(second, /would restart:agent-service/, 'Agent Service waits for 3');
  const third = runG();
  assert.match(third, /would restart:agent-service/);
  assert.match(third, /would restart:hermes/);
});

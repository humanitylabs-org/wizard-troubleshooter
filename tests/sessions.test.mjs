// Past sessions: the page lists earlier Troubleshooter conversations (newest first, date + first line) and opens one
// read-only. Storage is the existing per-conversation JSON under <stateDir>/conversations, bounded in count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const state = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-sessions-'));
const CONV = path.join(state, 'conversations');
fs.mkdirSync(CONV, { recursive: true });
const at = m => new Date(Date.UTC(2026, 9, 27, 8, m)).toISOString();
function conv(id, minute, text, extra = {}) {
  const c = { id, title: text.slice(0, 80), origin: 'owner', createdAt: at(minute), updatedAt: at(minute + 1), running: false, claudeSession: 'secret-session-' + id, lastEngine: 'claude',
    events: [{ seq: 1, type: 'text', role: 'owner', text }, { seq: 2, type: 'text', role: 'agent', engine: 'claude', text: 'Fixed.' }, { seq: 3, type: 'end' }], ...extra };
  fs.writeFileSync(path.join(CONV, id + '.json'), JSON.stringify(c));
  const t = new Date(c.updatedAt); fs.utimesSync(path.join(CONV, id + '.json'), t, t);
}
conv('aaaaaaaaaaaaaaa1', 1, 'Oldest problem');
conv('aaaaaaaaaaaaaaa2', 5, 'My Wizard is down, please fix it.\n\n[Automatic check right now: Agent Service: Not running.]');
conv('aaaaaaaaaaaaaaa3', 9, '\n  Messages won\'t send\nsecond line');
fs.writeFileSync(path.join(CONV, 'not-json.json'), '{broken');

process.env.TROUBLESHOOT_STATE = state;
process.env.HOME = path.join(state, 'home');
const { listConvs, pruneConvs, firstLine } = await import('../lib/repair.mjs');

test('past sessions are newest first with date and a clean first line, and never leak the Claude session id', () => {
  const list = listConvs(10);
  assert.deepEqual(list.map(c => c.id), ['aaaaaaaaaaaaaaa3', 'aaaaaaaaaaaaaaa2', 'aaaaaaaaaaaaaaa1']);
  assert.equal(list[0].first, "Messages won't send");
  assert.equal(list[1].first, 'My Wizard is down, please fix it.', 'automatic-check context is cut');
  assert.equal(list[1].createdAt, at(5));
  assert.equal(list[0].engine, 'claude');
  assert.ok(!JSON.stringify(list).includes('secret-session'), 'no Claude session id in the list');
  assert.equal(listConvs(1).length, 1, 'limit honoured');
  assert.equal(listConvs(9999).length, 3, 'limit is capped, not an error');
  assert.equal(firstLine({ events: [], title: '' }), '');
});

test('the session store is bounded and never removes the protected (running) session', () => {
  const removed = pruneConvs(2, 'aaaaaaaaaaaaaaa1');
  assert.ok(fs.existsSync(path.join(CONV, 'aaaaaaaaaaaaaaa1.json')), 'protected session kept even though it is oldest');
  assert.ok(removed >= 1);
  assert.ok(fs.existsSync(path.join(CONV, 'aaaaaaaaaaaaaaa3.json')), 'newest kept');
});

test('GET /api/repairs and /api/repair/:id serve the list and one thread; no POST needed to read', async () => {
  const s2 = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-sessions-http-'));
  fs.mkdirSync(path.join(s2, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(s2, 'home'));
  fs.copyFileSync(path.join(CONV, 'aaaaaaaaaaaaaaa3.json'), path.join(s2, 'conversations', 'aaaaaaaaaaaaaaa3.json'));
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(TROUBLESHOOT_|GUARDIAN_|WAS_|TS_|TAILSCALE_|GATEWAY_|AUTH_|SHELL_|AGENT_|HERMES_|CLAUDE_|CHATGPT_|TINFOIL_|WIZARD_|DOCKER_)/.test(k)) delete base[k];
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], { env: { ...base, HOME: path.join(s2, 'home'), TROUBLESHOOT_STATE: s2, TROUBLESHOOT_DEV_NO_AUTH: '1', PORT: String(port),
    TS_SOCKET: path.join(s2, 'no.sock'), WAS_RELEASE_ROOT: path.join(s2, 'rel'), CLAUDE_CONFIG_DIR: path.join(s2, 'no-claude'), CLAUDE_BIN: '/bin/false', DOCKER_BIN: '/bin/false', TAILSCALE_UNIT: '', GATEWAY_UNIT: '', AUTH_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { let out = ''; const t = setTimeout(() => reject(new Error('no start')), 5000); child.stdout.on('data', d => { out += d; if (out.includes(`:${port}/troubleshoot`)) { clearTimeout(t); resolve(); } }); });
    const B = `http://127.0.0.1:${port}/troubleshoot/api`;
    const r = await (await fetch(`${B}/repairs?limit=5`)).json();
    assert.equal(r.repairs.length, 1); assert.equal(r.repairs[0].first, "Messages won't send"); assert.equal(r.running, null);
    const one = await (await fetch(`${B}/repair/aaaaaaaaaaaaaaa3`)).json();
    assert.equal(one.events.length, 3); assert.equal(one.running, false); assert.equal(one.createdAt, at(9));
    assert.ok(!JSON.stringify(one).includes('secret-session'));
    assert.equal((await fetch(`${B}/repair/zzzz`)).status, 404);
  } finally { child.kill(); }
});

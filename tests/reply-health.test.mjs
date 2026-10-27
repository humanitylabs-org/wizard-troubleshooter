import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { providerFailure, cachedProbe, replyResult } from '../lib/reply-health.mjs';
const ROOT = path.resolve(import.meta.dirname, '..'), NODE = process.execPath;
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'reply-health-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const observed = 'Failed to authenticate: OAuth session expired and could not be refreshed';
function env(state, extra = {}) {
  const home = path.join(state, 'home'); fs.mkdirSync(home, { recursive: true });
  return { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, TROUBLESHOOT_STATE: state, TROUBLESHOOT_DEV_NO_AUTH: '1', TS_SOCKET: path.join(state, 'no.sock'), AGENT_PORT: '1', HERMES_PORT: '2', SHELL_PORT: '3', GATEWAY_PORT: '4', AUTH_PORT: '', TAILSCALE_UNIT: '', GATEWAY_UNIT: '', SHELL_CONTAINER: '', AGENT_UNIT: '', HERMES_UNIT: '', WAS_RELEASE_ROOT: path.join(state, 'no-release'), CLAUDE_BIN: '/bin/false', CODEX_BIN: '/bin/false', CLAUDE_CONFIG_DIR: path.join(state, 'claude'), CLAUDE_AGENT_AUTH_FILE: path.join(state, 'no-auth'), CHATGPT_AUTH_FILE: path.join(state, 'no-auth'), CODEX_HOME: path.join(state, 'codex'), TINFOIL_URL: 'http://127.0.0.1:9', TINFOIL_TOKEN_FILE: path.join(state, 'no-tinfoil'), DOCKER_BIN: '/bin/false', ...extra };
}
const listen = handler => new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
async function cmd(args, e, cwd = ROOT) {
  const p = spawn(NODE, args, { env: e, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  const code = await new Promise(r => p.on('exit', r)); assert.equal(code, 0, err); return out;
}
async function server(e) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(NODE, ['server.mjs'], { cwd: ROOT, env: { ...e, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('start timeout')), 5000); p.stdout.on('data', () => { clearTimeout(t); resolve(); }); p.on('exit', () => { clearTimeout(t); reject(new Error('server exited')); }); });
  return { p, base: `http://127.0.0.1:${port}/troubleshoot/api/` };
}
function fixtures(state, notice = observed, genuine = '') {
  fs.mkdirSync(path.join(state, 'claude')); fs.mkdirSync(path.join(state, 'codex'));
  fs.writeFileSync(path.join(state, 'claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture', refreshToken: 'fixture' } }));
  fs.writeFileSync(path.join(state, 'codex/auth.json'), JSON.stringify({ tokens: { access_token: 'fixture' } }));
  const claude = path.join(state, 'fake-claude'), codex = path.join(state, 'fake-codex');
  const events = [...(genuine ? [{ type: 'assistant', message: { content: [{ type: 'text', text: genuine }] } }] : []), { type: 'assistant', message: { content: [{ type: 'text', text: notice }] } }, { type: 'result', is_error: true }];
  fs.writeFileSync(claude, '#!/bin/sh\n' + events.map(j => `printf '%s\\n' '${JSON.stringify(j).replaceAll("'", "'\\''")}'`).join('\n') + '\n', { mode: 0o755 });
  const result = { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ text: 'ChatGPT answered the repair request.', calls: [] }) } };
  fs.writeFileSync(codex, '#!/bin/sh\nprintf \'%s\\n\' \'' + JSON.stringify(result) + '\'\n', { mode: 0o755 });
  return { CLAUDE_BIN: claude, CODEX_BIN: codex };
}
async function chat(base, engine = 'auto') {
  const response = await fetch(base + 'repair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wizard-Troubleshoot': '1' }, body: JSON.stringify({ engine, message: 'Please help.' }) });
  assert.equal(response.status, 202); const { id } = await response.json();
  for (let i = 0; i < 150; i++) { const c = await (await fetch(base + 'repair/' + id)).json(); if (!c.running) return c; await sleep(30); }
  throw new Error('repair did not end');
}

test('falls back to ChatGPT when the Claude sign-in has expired', async () => {
  const state = tmp(), f = fixtures(state), s = await server(env(state, f));
  try {
    const c = await chat(s.base, 'claude');
    assert.ok(c.events.some(e => e.type === 'signin' && e.state === 'expired' && /Claude.*sign-in has expired.*ChatGPT is taking over/.test(e.text)));
    assert.deepEqual(c.events.filter(e => e.type === 'text' && e.role === 'agent').map(e => [e.engine, e.text]), [['chatgpt', 'ChatGPT answered the repair request.']]);
    const health = JSON.parse(fs.readFileSync(path.join(state, 'reply-claude.json'))); assert.equal(health.state, 'expired');
  } finally { s.p.kill(); }
});
test('falls back to ChatGPT when a non-synthetic Claude assistant block is only a usage limit', async () => {
  const state = tmp(), s = await server(env(state, fixtures(state, "You've hit your weekly limit")));
  try { const c = await chat(s.base); assert.ok(c.events.some(e => e.engine === 'chatgpt' && e.role === 'agent')); assert.ok(!c.events.some(e => e.role === 'agent' && /weekly limit/.test(e.text))); } finally { s.p.kill(); }
});
test('does not swallow a genuine answer or repeat a repair after a later auth error', async () => {
  const state = tmp(), s = await server(env(state, fixtures(state, observed, 'I checked the configuration. Your Claude sign-in has expired; reconnect it in the Claude app.')));
  try { const c = await chat(s.base); assert.equal(c.events.filter(e => e.role === 'agent').length, 1); assert.equal(c.events.find(e => e.role === 'agent').engine, 'claude'); } finally { s.p.kill(); }
});
test('auth classification is notice-only; an HTTP 200 auth failure is not an OK reply', () => {
  assert.equal(replyResult('No Anthropic credentials found. Please sign in.').state, 'expired');
  assert.equal(replyResult(observed, 'Claude').provider, 'Claude');
  assert.equal(providerFailure('I fixed the config; it mentioned auth and a 401.'), null);
  assert.equal(providerFailure('OAuth sessions expire periodically. Reconnect them from the connection app.'), null);
  assert.equal(providerFailure('Usage limits depend on your plan. I checked your account and it is ready.'), null);
  assert.equal(providerFailure('Your authentication token could not be refreshed because the refresh token expired').state, 'expired');
  assert.equal(replyResult('OK').ok, true); assert.equal(replyResult('').ok, false);
});
test('reply probe cache spends at most one healthy request in ten minutes, retries failures each minute, and force bypasses it', async () => {
  const state = tmp(); let count = 0, good = true;
  const probe = async () => { count++; await sleep(10); return { ok: good, detail: 'fixture' }; };
  const a = await cachedProbe(state, 'test', probe);
  await cachedProbe(state, 'test', probe, { now: a.checkedAt + 599999 }); assert.equal(count, 1);
  await cachedProbe(state, 'test', probe, { now: a.checkedAt + 600001 }); assert.equal(count, 2);
  good = false; const b = await cachedProbe(state, 'test', probe, { force: true }); assert.equal(count, 3);
  await cachedProbe(state, 'test', probe, { now: b.checkedAt + 59999 }); assert.equal(count, 3);
  await cachedProbe(state, 'test', probe, { now: b.checkedAt + 60001 }); assert.equal(count, 4);
  await Promise.all([cachedProbe(state, 'test', probe, { force: true }), cachedProbe(state, 'test', probe, { force: true })]); assert.equal(count, 5);
});
test('real main-agent reply check detects a controlled HTTP 200 auth failure and recovers on a forced request; never prints the key', async () => {
  const state = tmp(); let good = false, calls = 0;
  const api = await listen(async (q, r) => { let raw = ''; for await (const b of q) raw += b; const body = JSON.parse(raw); calls++; assert.equal(q.url, '/v1/chat/completions'); assert.equal(q.headers.authorization, 'Bearer fixture-secret'); assert.equal(body.model, 'hermes-agent'); assert.equal(body.messages[0].content, 'Reply with just OK. Do not use tools.'); r.end(JSON.stringify({ choices: [{ message: { content: good ? 'OK' : 'No Anthropic credentials found. OAuth refresh token expired.' } }] })); });
  const e = env(state, { HERMES_PORT: String(api.address().port) });
  fs.mkdirSync(path.join(e.HOME, '.hermes')); fs.writeFileSync(path.join(e.HOME, '.hermes/.env'), 'API_SERVER_KEY="fixture-secret"\n');
  const js = "import { agentReply } from './lib/agent-reply.mjs'; import { CONFIG,run } from './lib/checks.mjs'; console.log(JSON.stringify(await agentReply(CONFIG,run,{force:process.argv[1]==='force'})));";
  try {
    const a = JSON.parse(await cmd(['--input-type=module', '-e', js], e)); assert.equal(a.state, 'expired'); assert.equal(a.provider, 'Claude'); assert.equal(a.ok, false);
    assert.ok(!(await cmd(['--input-type=module', '-e', js], e)).includes('fixture-secret')); assert.equal(calls, 1);
    good = true; const b = JSON.parse(await cmd(['--input-type=module', '-e', js, 'force'], e)); assert.equal(b.ok, true); assert.equal(calls, 2);
  } finally { api.close(); }
});
test('an uninstalled optional Tinfoil app is not an outage or a promise it can reply', async () => {
  const state = tmp(), reg = path.join(state, 'apps.json'); fs.writeFileSync(reg, '{"apps":[]}');
  const r = JSON.parse(await cmd(['--input-type=module', '-e', "import {engineReply} from './lib/providers.mjs';console.log(JSON.stringify(await engineReply('tinfoil')));"], env(state, { WIZARD_APPS_FILE: reg })));
  assert.equal(r.ok, false); assert.equal(r.skipped, true);
});

test('fresh-box reply check uses the Hermes container loopback API, not the Agent Service health flag', async () => {
  const state = tmp(), marker = path.join(state, 'argv'), docker = path.join(state, 'docker');
  fs.writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\nprintf '%s\\n' '{"text":"No Anthropic credentials found"}'\n`, { mode: 0o755 });
  const e = env(state, { HERMES_PORT: '0', HERMES_CONTAINER: 'main-hermes-fixture', DOCKER_BIN: docker });
  const a = JSON.parse(await cmd(['--input-type=module', '-e', "import { agentReply } from './lib/agent-reply.mjs'; import {CONFIG,run} from './lib/checks.mjs'; console.log(JSON.stringify(await agentReply(CONFIG,run)));"], e));
  assert.equal(a.state, 'expired'); const args = fs.readFileSync(marker, 'utf8'); assert.match(args, /exec\nmain-hermes-fixture\n\/opt\/hermes\/\.venv\/bin\/python/); assert.match(args, /8642\/v1\/chat\/completions/); assert.match(args, /API_SERVER_KEY/);
});
test('guardian needs two distinct failed replies, reports once, starts backup repair without restarting, and records recovery', async () => {
  const state = tmp(); let good = false, repairs = 0;
  const api = await listen(async (q, r) => { for await (const _ of q) {} if (q.url === '/troubleshoot/api/guardian-repair') { repairs++; r.end('{"id":"0123456789abcdef"}'); } else if (q.url === '/v1/chat/completions') r.end(JSON.stringify({ choices: [{ message: { content: good ? 'OK' : 'No Anthropic credentials found' } }] })); else r.end(JSON.stringify({ status: 'ok', upstream_reachable: true, Self: { DNSName: 'fixture' }, BackendState: 'Running' })); });
  const socket = path.join(state, 'tailscale.sock'), ts = http.createServer((q, r) => r.end('{"BackendState":"Running","Self":{"DNSName":"fixture"}}')); await new Promise(r => ts.listen(socket, r));
  const timeZoneLabel = 'Asia/Bangkok';
  const e = env(state, { TS_SOCKET: socket, AGENT_PORT: String(api.address().port), HERMES_PORT: String(api.address().port), SHELL_PORT: String(api.address().port), GATEWAY_PORT: String(api.address().port), TROUBLESHOOT_PORT: String(api.address().port), GUARDIAN_THREAD: 'fixture-thread', GUARDIAN_TZ: timeZoneLabel });
  const py = path.join(e.HOME, '.hermes/hermes-agent/venv/bin/python'); fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(py, `#!${NODE}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(path.join(state, 'reports'))}, fs.readFileSync(process.argv.at(-1),'utf8')+'\\n');\n`, { mode: 0o755 });
  for (const id of ['claude', 'chatgpt', 'tinfoil']) fs.writeFileSync(path.join(state, `reply-${id}.json`), JSON.stringify({ ok: true, detail: 'fixture', checkedAt: Date.now() }));
  const tick = () => cmd(['bin/guardian.mjs'], e);
  const expire = () => { const f = path.join(state, 'reply-agent.json'), c = JSON.parse(fs.readFileSync(f)); c.checkedAt -= 61000; fs.writeFileSync(f, JSON.stringify(c)); };
  try {
    await tick(); assert.equal(repairs, 0); await tick(); assert.equal(repairs, 0, 'cached failure is not a second probe');
    expire(); await tick(); assert.equal(repairs, 1);
    expire(); await tick(); assert.equal(repairs, 1, 'one backup repair per outage');
    const gs = JSON.parse(fs.readFileSync(path.join(state, 'guardian.json'))); assert.deepEqual(gs.fixes, {}, 'no restart budget spent on a dead sign-in');
    const reports = fs.readFileSync(path.join(state, 'reports'), 'utf8'); assert.equal((reports.match(/Wizard can't reply/g) || []).length, 1); assert.match(reports, /Claude sign-in expired/);
    good = true; expire(); await tick(); const incidents = fs.readFileSync(path.join(state, 'incidents.jsonl'), 'utf8'); assert.match(incidents, /"kind":"outage"/); assert.match(incidents, /"kind":"recovered"/); assert.match(fs.readFileSync(path.join(state, 'reports'), 'utf8'), /Wizard is working again/);
  } finally { api.close(); ts.close(); }
});

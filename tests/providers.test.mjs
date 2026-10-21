// Repair chat through the box's connection apps: routing, fallback, missing sign-ins, the bounded tool loop,
// secrets never logged, and the Tailscale Serve owner gate. All providers are fakes; nothing leaves this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NODE = process.execPath;
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-prov-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const SECRET_SIG = 'SIGNATURE' + 'x'.repeat(40);
const fakeJwt = (expH = 5) => `${b64({ alg: 'RS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expH * 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test', chatgpt_plan_type: 'pro' }, 'https://api.openai.com/profile': { email: 'owner@example.com' } })}.${SECRET_SIG}`;
const TINFOIL_GATEWAY_SECRET = 'tinfoil-gateway-credential-' + 'q'.repeat(30);

function listen(handler) {
  return new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port })); });
}
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => r(b)); });

// Isolated host: every Wizard link points at a dead port, no real sign-in store is reachable.
function hostEnv(state, extra = {}) {
  return {
    TROUBLESHOOT_STATE: state, TROUBLESHOOT_DEV_NO_AUTH: '1', TS_SOCKET: path.join(state, 'no.sock'),
    AGENT_PORT: '1', HERMES_PORT: '2', SHELL_PORT: '3', GATEWAY_PORT: '4', AUTH_PORT: '',
    CLAUDE_CONFIG_DIR: path.join(state, 'claude-empty'), CLAUDE_BIN: '/bin/false',
    CHATGPT_AUTH_FILE: path.join(state, 'no-auth.json'), CHATGPT_BASE_URL: 'http://127.0.0.1:9',
    TINFOIL_URL: 'http://127.0.0.1:9', TINFOIL_TOKEN_FILE: path.join(state, 'no-token.json'),
    DOCKER_BIN: '/bin/false', HOME: process.env.HOME, ...extra,
  };
}
async function startServer(env) {
  // Wait for OUR process to report it is listening (a parallel test file may own a colliding random port).
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(NODE, [path.join(APP, 'server.mjs')], { env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    const up = await new Promise(resolve => {
      const t = setTimeout(() => resolve(false), 5000);
      child.stdout.on('data', d => { logs += d; if (logs.includes(`:${port}/troubleshoot`)) { clearTimeout(t); resolve(true); } });
      child.stderr.on('data', d => { logs += d; });
      child.on('exit', () => { clearTimeout(t); resolve(false); });
    });
    if (up) return { port, child, logs: () => logs };
    child.kill();
  }
  throw new Error('server did not start');
}
const H = { 'Content-Type': 'application/json', 'X-Wizard-Troubleshoot': '1' };
async function chat(port, message, engine) {
  const r = await fetch(`http://127.0.0.1:${port}/troubleshoot/api/repair`, { method: 'POST', headers: H, body: JSON.stringify({ message, engine }) });
  assert.equal(r.status, 202);
  const { id, order } = await r.json();
  let c;
  for (let i = 0; i < 150; i++) { c = await (await fetch(`http://127.0.0.1:${port}/troubleshoot/api/repair/${id}`)).json(); if (!c.running) break; await sleep(100); }
  return { ...c, order };
}

test('routing: default order is Claude, ChatGPT, Tinfoil; a picked engine is the only one tried', async () => {
  const state = tmp();
  const { port, child } = await startServer(hostEnv(state));
  try {
    const auto = await chat(port, 'hello', 'auto');
    assert.deepEqual(auto.order, ['claude', 'chatgpt', 'tinfoil']);
    assert.deepEqual(auto.events.filter(e => e.type === 'signin').map(e => e.engine), ['claude', 'chatgpt', 'tinfoil']);
    const only = await chat(port, 'hello', 'tinfoil');
    assert.deepEqual(only.order, ['tinfoil']);
    assert.deepEqual(only.events.filter(e => e.type === 'signin').map(e => e.engine), ['tinfoil']);
    const eng = await (await fetch(`http://127.0.0.1:${port}/troubleshoot/api/engines`)).json();
    assert.deepEqual(eng.engines.map(e => [e.engine, e.app, e.open]), [['claude', 'Claude app', '/wizard-claude/'], ['chatgpt', 'ChatGPT app', '/wizard-chatgpt/'], ['tinfoil', 'Tinfoil app', '/wizard-tinfoil/']]);
  } finally { child.kill(); }
});

test('missing sign-ins: each engine says which app to open, then the chat ends honestly', async () => {
  const state = tmp();
  const { port, child } = await startServer(hostEnv(state));
  try {
    const c = await chat(port, 'My Wizard is down', 'auto');
    const s = c.events.filter(e => e.type === 'signin');
    assert.match(s[0].text, /Claude app has no sign-in.*Open the Claude app/);
    assert.match(s[0].text, /Trying ChatGPT instead/);
    assert.match(s[1].text, /ChatGPT app has no sign-in/);
    assert.match(s[2].text, /Tinfoil app is not answering/);
    assert.deepEqual(s.map(e => e.open), ['/wizard-claude/', '/wizard-chatgpt/', '/wizard-tinfoil/']);
    assert.match(c.events.find(e => e.type === 'note').text, /No AI could answer/);
    assert.equal(c.events.at(-1).type, 'end');
  } finally { child.kill(); }
});

test('expired ChatGPT sign-in is reported as expired, not used', async () => {
  const state = tmp();
  fs.writeFileSync(path.join(state, 'auth.json'), JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: fakeJwt(-1) } } } }));
  let called = 0;
  const fake = await listen((req, res) => { called++; res.end('{}'); });
  const { port, child } = await startServer(hostEnv(state, { CHATGPT_AUTH_FILE: path.join(state, 'auth.json'), CHATGPT_BASE_URL: `http://127.0.0.1:${fake.port}` }));
  try {
    const c = await chat(port, 'hi', 'chatgpt');
    assert.match(c.events.find(e => e.type === 'signin').text, /ChatGPT app's sign-in has expired/);
    assert.equal(called, 0);
  } finally { child.kill(); fake.s.close(); }
});

test('fallback: Claude has no sign-in, ChatGPT answers with the ChatGPT app sign-in after reading real checks', async () => {
  const state = tmp();
  const jwt = fakeJwt();
  fs.writeFileSync(path.join(state, 'auth.json'), JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: jwt, refresh_token: 'rt-never-used-' + 'z'.repeat(30) } } } }));
  const seen = [];
  const fake = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    seen.push({ auth: req.headers.authorization, acct: req.headers['chatgpt-account-id'], body });
    const out = seen.length === 1
      ? [{ type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'check_status', arguments: '{}' }]
      : [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'Hermes is not running and the Agent Service is not running.' }] }];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ type: 'response.created' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: out } })}\n\n`);
  });
  const { port, child, logs } = await startServer(hostEnv(state, { CHATGPT_AUTH_FILE: path.join(state, 'auth.json'), CHATGPT_BASE_URL: `http://127.0.0.1:${fake.port}` }));
  try {
    const c = await chat(port, 'check the box status', 'auto');
    assert.equal(c.events.find(e => e.type === 'signin').engine, 'claude');
    assert.match(c.events.find(e => e.type === 'status').text, /ChatGPT is looking into it/);
    assert.equal(c.events.find(e => e.type === 'status').via, 'ChatGPT app');
    const answer = c.events.find(e => e.type === 'text' && e.role === 'agent');
    assert.equal(answer.engine, 'chatgpt');
    assert.match(answer.text, /Hermes is not running/);
    assert.equal(seen[0].auth, 'Bearer ' + jwt, 'uses the ChatGPT app store token in place');
    assert.equal(seen[0].acct, 'acct-test');
    assert.ok(seen[0].body.tools.some(t => t.name === 'run_fix'), 'tool loop offers the fixed fixes');
    const output = seen[1].body.input.find(i => i.type === 'function_call_output');
    assert.match(output.output, /FAIL hermes/, 'model received the real status checks');
    // never logged or stored
    const stored = fs.readdirSync(path.join(state, 'conversations')).map(f => fs.readFileSync(path.join(state, 'conversations', f), 'utf8')).join('');
    for (const hay of [stored, logs(), fs.existsSync(path.join(state, 'incidents.jsonl')) ? fs.readFileSync(path.join(state, 'incidents.jsonl'), 'utf8') : '']) {
      assert.ok(!hay.includes(SECRET_SIG) && !hay.includes(jwt) && !hay.includes('rt-never-used'), 'no token in logs or conversations');
    }
    const st = await (await fetch(`http://127.0.0.1:${port}/troubleshoot/api/status?accounts=1`)).text();
    assert.ok(!st.includes(SECRET_SIG), 'status API never returns the token');
  } finally { child.kill(); fake.s.close(); }
});

test('Tinfoil tool loop: diagnoses with checks and applies a fixed fix to a failing link; key never logged', async () => {
  const state = tmp();
  fs.writeFileSync(path.join(state, 'tf-token.json'), JSON.stringify({ token: TINFOIL_GATEWAY_SECRET }));
  const marker = path.join(state, 'restarted');
  const docker = path.join(state, 'docker');
  fs.writeFileSync(docker, `#!/bin/sh\necho "$@" >> '${marker}'\n`, { mode: 0o755 });
  const seen = [];
  const fake = await listen(async (req, res) => {
    const u = req.url;
    if (u === '/api/status') return res.end(JSON.stringify({ status: 'connected', models: ['nomic-embed-text', 'glm-5-3'] }));
    const body = JSON.parse(await readBody(req));
    seen.push({ auth: req.headers.authorization, body });
    const n = seen.length;
    const msg = n === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'check_status', arguments: '{}' } }] }
      : n === 2 ? { role: 'assistant', content: 'The app screens are down. Restarting them.', tool_calls: [{ id: 't2', type: 'function', function: { name: 'run_fix', arguments: '{"action":"restart:shell"}' } }] }
      : n === 3 ? { role: 'assistant', content: null, tool_calls: [{ id: 't3', type: 'function', function: { name: 'run_fix', arguments: '{"action":"restart:disk"}' } }] }
      : { role: 'assistant', content: 'I restarted the Wizard app screens.' };
    res.end(JSON.stringify({ choices: [{ message: msg }] }));
  });
  const { port, child, logs } = await startServer(hostEnv(state, { TINFOIL_URL: `http://127.0.0.1:${fake.port}`, TINFOIL_TOKEN_FILE: path.join(state, 'tf-token.json'), DOCKER_BIN: docker, SHELL_CONTAINER: 'fake-shell' }));
  try {
    const c = await chat(port, 'check the box status and fix it', 'tinfoil');
    assert.equal(seen[0].auth, 'Bearer ' + TINFOIL_GATEWAY_SECRET);
    assert.equal(seen[0].body.model, 'glm-5-3', 'picks a chat model, not an embedding model');
    assert.match(seen[0].body.messages[0].content, /Wizard Repair Technician/);
    const toolMsg = seen[1].body.messages.find(m => m.role === 'tool' && m.tool_call_id === 't1');
    assert.match(toolMsg.content, /FAIL shell .*\[fix: restart:shell\]/);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'restart fake-shell', 'the fixed fix ran exactly once');
    const bad = seen[3].body.messages.find(m => m.role === 'tool' && m.tool_call_id === 't3');
    assert.match(bad.content, /unknown fix/, 'free-form or unknown fixes are refused');
    const texts = c.events.filter(e => e.type === 'text' && e.role === 'agent').map(e => e.text);
    assert.deepEqual(texts, ['The app screens are down. Restarting them.', 'I restarted the Wizard app screens.']);
    assert.ok(c.events.some(e => e.type === 'tool' && /fix restart:shell/.test(e.text)));
    const stored = fs.readdirSync(path.join(state, 'conversations')).map(f => fs.readFileSync(path.join(state, 'conversations', f), 'utf8')).join('') + fs.readFileSync(path.join(state, 'incidents.jsonl'), 'utf8');
    assert.ok(!stored.includes(TINFOIL_GATEWAY_SECRET) && !logs().includes(TINFOIL_GATEWAY_SECRET), 'gateway credential never logged');
  } finally { child.kill(); fake.s.close(); }
});

test('run_fix refuses to restart a link that is working', async () => {
  const state = tmp();
  process.env.TROUBLESHOOT_STATE = state;
  const shell = await listen((req, res) => res.end('ok'));
  process.env.SHELL_PORT = String(shell.port); process.env.SHELL_CONTAINER = 'fake-shell'; process.env.DOCKER_BIN = '/bin/false';
  try {
    const { callTool } = await import('../lib/toolloop.mjs?refuse');
    const out = await callTool('run_fix', '{"action":"restart:shell"}');
    assert.match(out, /Refused: Wizard app screens is working right now/);
  } finally { shell.s.close(); }
});

test('scrub removes token-shaped strings from tool output', async () => {
  const { scrub } = await import('../lib/toolloop.mjs?scrub');
  const s = scrub(`Authorization: Bearer abcdefghijklmnop1234 jwt ${fakeJwt()} sk-${'a'.repeat(30)} password=hunter2hunter2 ${'ab'.repeat(30)}`);
  assert.ok(!s.includes(SECRET_SIG) && !s.includes('hunter2') && !s.includes('abcdefghijklmnop1234') && !s.includes('a'.repeat(30)) && !s.includes('ab'.repeat(30)), s);
});

// Owner gate behind Tailscale Serve: Serve proxies from loopback and sets X-Forwarded-For to the peer's tailnet IP.
test('owner gate (tailscale-serve): whois-confirmed owner only; spoofed, foreign, tagged or non-loopback refused', async () => {
  const state = tmp();
  const sock = path.join(state, 'ts.sock');
  const peers = { '100.70.0.1': { user: 7, login: 'owner@example.com' }, '100.70.0.2': { user: 8, login: 'guest@example.com' }, '100.70.0.3': { user: 7, login: 'owner@example.com', tags: ['tag:server'] } };
  const ts = http.createServer((req, res) => {
    const addr = new URL(req.url, 'http://x').searchParams.get('addr');
    const p = peers[addr];
    if (!p) { res.writeHead(404); return res.end(); }
    res.end(JSON.stringify({ Node: { User: p.user, Tags: p.tags || [] }, UserProfile: { ID: p.user, LoginName: p.login } }));
  });
  await new Promise(r => ts.listen(sock, r));
  const { port, child } = await startServer({ ...hostEnv(state), TROUBLESHOOT_DEV_NO_AUTH: '', TROUBLESHOOT_FRONT: 'tailscale-serve', TS_WHOIS_SOCKET: sock, TROUBLESHOOT_OWNERS: 'owner@example.com', WIZARD_PRIVATE_ORIGINS: 'https://box.example.ts.net:8444' });
  try {
    const get = h => fetch(`http://127.0.0.1:${port}/troubleshoot/api/status`, { headers: h }).then(r => r.status);
    assert.equal(await get({ 'X-Forwarded-For': '100.70.0.1', 'Tailscale-User-Login': 'owner@example.com' }), 200, 'owner');
    assert.equal(await get({ 'X-Forwarded-For': '100.70.0.1' }), 200, 'owner without the optional login header');
    assert.equal(await get({}), 403, 'no peer');
    assert.equal(await get({ 'X-Forwarded-For': '100.70.0.2', 'Tailscale-User-Login': 'guest@example.com' }), 403, 'other tailnet user not on the owner list');
    assert.equal(await get({ 'X-Forwarded-For': '100.70.0.2', 'Tailscale-User-Login': 'owner@example.com' }), 403, 'login header that whois contradicts');
    assert.equal(await get({ 'X-Forwarded-For': '100.70.0.3' }), 403, 'tagged device');
    assert.equal(await get({ 'X-Forwarded-For': '8.8.8.8' }), 403, 'not a tailnet address');
    assert.equal(await get({ 'X-Forwarded-For': '1.2.3.4, 100.70.0.1' }), 403, 'chained forwarding');
    const post = (origin) => fetch(`http://127.0.0.1:${port}/troubleshoot/api/repair`, { method: 'POST', headers: { ...H, 'X-Forwarded-For': '100.70.0.1', Origin: origin }, body: JSON.stringify({ message: 'x' }) }).then(r => r.status);
    assert.equal(await post('https://evil.example'), 403, 'cross-site POST');
  } finally { child.kill(); ts.close(); }
});

test('tool loop: a provider error after the model already answered keeps the answer and says it stopped partway', async () => {
  const state = tmp();
  fs.writeFileSync(path.join(state, 'tf-token.json'), JSON.stringify({ token: TINFOIL_GATEWAY_SECRET }));
  let n = 0;
  const fake = await listen(async (req, res) => {
    if (req.url === '/api/status') return res.end(JSON.stringify({ status: 'connected', models: ['glm-5-3'] }));
    await readBody(req); n++;
    if (n === 1) return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'disk_usage', arguments: '{}' } }] } }] }));
    res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid request or provider verification failed.' }));
  });
  const { port, child } = await startServer(hostEnv(state, { TINFOIL_URL: `http://127.0.0.1:${fake.port}`, TINFOIL_TOKEN_FILE: path.join(state, 'tf-token.json') }));
  try {
    const c = await chat(port, 'look', 'tinfoil');
    assert.equal(n, 3, 'retried once with shortened tool output');
    assert.ok(c.events.some(e => e.type === 'note' && /Tinfoil stopped partway/.test(e.text)));
    assert.ok(!c.events.some(e => e.type === 'note' && /No AI could answer/.test(e.text)));
  } finally { child.kill(); fake.s.close(); }
});

// --- Model picker -------------------------------------------------------------------------------------------
const engines = port => fetch(`http://127.0.0.1:${port}/troubleshoot/api/engines`).then(r => r.json());
const setEngine = (port, engine) => fetch(`http://127.0.0.1:${port}/troubleshoot/api/engine`, { method: 'POST', headers: H, body: JSON.stringify({ engine }) });
function fakeClaude(state, model = 'claude-opus-5-5') {
  const dir = path.join(state, 'claude-home');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
  const bin = path.join(state, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\necho '{"type":"system","subtype":"init","session_id":"s1","model":"${model}"}'\necho '{"type":"assistant","message":{"model":"${model}","content":[{"type":"text","text":"All good."}]}}'\necho '{"type":"result","session_id":"s1","is_error":false}'\n`, { mode: 0o755 });
  return { CLAUDE_CONFIG_DIR: dir, CLAUDE_BIN: bin };
}

test('picker: lists every provider with its real model, default is the first ready one (Claude), unavailable ones say why', async () => {
  const state = tmp();
  fs.writeFileSync(path.join(state, 'auth.json'), JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: fakeJwt() } } } }));
  const { port, child } = await startServer(hostEnv(state, { ...fakeClaude(state), CHATGPT_AUTH_FILE: path.join(state, 'auth.json') }));
  try {
    const e = await engines(port);
    assert.deepEqual(e.engines.map(a => a.engine), ['claude', 'chatgpt', 'tinfoil']);
    assert.equal(e.selected, 'claude', 'Claude is the default when signed in');
    const by = Object.fromEntries(e.engines.map(a => [a.engine, a]));
    assert.equal(by.claude.model, 'claude-opus-5-5', 'model read from Claude Code itself');
    assert.equal(by.claude.modelLabel, 'Opus 5.5');
    assert.equal(by.chatgpt.modelLabel, 'GPT-5.6 Luna');
    assert.equal(by.tinfoil.ok, false);
    assert.equal(by.tinfoil.reason, 'Not available', 'disabled provider carries a short reason');
    const c = await chat(port, 'hi', e.selected);
    const ans = c.events.find(x => x.type === 'text' && x.role === 'agent');
    assert.equal(ans.engine, 'claude'); assert.equal(ans.modelLabel, 'Opus 5.5', 'each answer keeps its answered-by label');
  } finally { child.kill(); }
});

test('picker: with no Claude sign-in the default is the next ready provider; a disabled one is never the default', async () => {
  const state = tmp();
  fs.writeFileSync(path.join(state, 'auth.json'), JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: fakeJwt() } } } }));
  const { port, child } = await startServer(hostEnv(state, { CHATGPT_AUTH_FILE: path.join(state, 'auth.json') }));
  try {
    const e = await engines(port);
    assert.equal(e.selected, 'chatgpt');
    const claude = e.engines.find(a => a.engine === 'claude');
    assert.equal(claude.ok, false); assert.equal(claude.reason, 'Not signed in');
  } finally { child.kill(); }
});

test('picker: the choice is saved on the server and survives a restart; unknown engines are refused', async () => {
  const state = tmp();
  let s = await startServer(hostEnv(state, fakeClaude(state)));
  try {
    assert.equal((await engines(s.port)).selected, 'claude');
    assert.equal((await setEngine(s.port, 'tinfoil')).status, 200);
    assert.equal((await engines(s.port)).selected, 'tinfoil', 'kept even though Tinfoil is not ready: never switched silently');
    assert.equal((await setEngine(s.port, 'auto')).status, 400);
    assert.equal((await setEngine(s.port, 'gpt-evil')).status, 400);
    const st = await (await fetch(`http://127.0.0.1:${s.port}/troubleshoot/api/status?accounts=1`)).json();
    assert.equal(st.engine, 'tinfoil');
  } finally { s.child.kill(); }
  s = await startServer(hostEnv(state, fakeClaude(state)));
  try { assert.equal((await engines(s.port)).selected, 'tinfoil', 'persists across restarts'); }
  finally { s.child.kill(); }
});

test('picker: the selected provider\'s sign-in expired -> plain message, Open app, offer the next one, no silent switch', async () => {
  const state = tmp();
  fs.writeFileSync(path.join(state, 'auth.json'), JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: fakeJwt(-1) } } } }));
  let chatgptCalls = 0;
  const fake = await listen((req, res) => { chatgptCalls++; res.end('{}'); });
  const claudeEnv = fakeClaude(state);
  const { port, child } = await startServer(hostEnv(state, { ...claudeEnv, CHATGPT_AUTH_FILE: path.join(state, 'auth.json'), CHATGPT_BASE_URL: `http://127.0.0.1:${fake.port}` }));
  try {
    await setEngine(port, 'chatgpt');
    const e = await engines(port);
    assert.equal(e.selected, 'chatgpt');
    assert.equal(e.engines.find(a => a.engine === 'chatgpt').reason, 'Sign-in expired');
    const c = await chat(port, 'hi', 'chatgpt');
    const s = c.events.find(x => x.type === 'signin');
    assert.match(s.text, /ChatGPT app's sign-in has expired/);
    assert.equal(s.open, '/wizard-chatgpt/');
    assert.equal(s.offer, 'claude', 'offers the next ready provider');
    assert.ok(!/Trying/.test(s.text));
    assert.ok(!c.events.some(x => x.type === 'text' && x.role === 'agent'), 'nobody else answered on its own');
    assert.ok(!c.events.some(x => x.type === 'note' && /No AI could answer/.test(x.text)));
    assert.equal(chatgptCalls, 0);
    assert.equal((await engines(port)).selected, 'chatgpt', 'the saved choice is unchanged');
  } finally { child.kill(); fake.s.close(); }
});

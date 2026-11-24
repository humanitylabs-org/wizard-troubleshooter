// #62 (24 Nov 2026): for six hours no chat got a reply while every check here was green. The server's Claude login
// that the agent answers with had expired (Hermes marked it dead), the real-reply check was off, and the Claude row
// called that login "the Claude app" and sent the owner to the Claude app, whose separate sign-in was fine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { providerFailure } from '../lib/reply-health.mjs';

const ROOT = path.resolve(import.meta.dirname, '..'), NODE = process.execPath;
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'agent-signin-'));
const SECRET = 'sk-ant-oat01-fixture-secret-never-shown';
const TERMINAL = 'Open a terminal on the server and run `claude`, then `/login`.';

function env(state, extra = {}) {
  const home = path.join(state, 'home'); fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
  return { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, TROUBLESHOOT_STATE: state, TROUBLESHOOT_DEV_NO_AUTH: '1', TS_SOCKET: path.join(state, 'no.sock'), AGENT_PORT: '1', HERMES_PORT: '2', SHELL_PORT: '3', GATEWAY_PORT: '4', AUTH_PORT: '', TAILSCALE_UNIT: '', GATEWAY_UNIT: '', SHELL_CONTAINER: '', AGENT_UNIT: '', HERMES_UNIT: '', RUN_KEEPER_UNIT: '', APP_ADDRESSES: '0', WAS_RELEASE_ROOT: path.join(state, 'no-release'), WAS_DEPLOY_BIN: path.join(state, 'no-deploy'), CLAUDE_BIN: '/bin/false', CODEX_BIN: '/bin/false', CHATGPT_AUTH_FILE: path.join(home, '.hermes/auth.json'), CODEX_HOME: path.join(state, 'codex'), TINFOIL_URL: 'http://127.0.0.1:9', TINFOIL_TOKEN_FILE: path.join(state, 'no-tinfoil'), DOCKER_BIN: '/bin/false', RUNTIPI_ROOT: path.join(state, 'runtipi'), ...extra };
}
// The 24 Nov outage: Hermes's main provider is Claude, its pooled copy of the server login is dead (invalid_grant),
// and the login file was last written before that.
function outage(e, { relogin = false, renew = true } = {}) {
  const hh = path.join(e.HOME, '.hermes'), cd = path.join(e.HOME, '.claude'), now = Date.now();
  fs.mkdirSync(cd, { recursive: true });
  fs.writeFileSync(path.join(hh, 'config.yaml'), 'model:\n  default: claude-opus-5-5\n  provider: anthropic\nagent:\n  provider: other\n');
  fs.writeFileSync(path.join(hh, '.env'), 'API_SERVER_KEY=fixture-key\n');
  fs.writeFileSync(path.join(hh, 'auth.json'), JSON.stringify({ credential_pool: { anthropic: [{ id: 'cc', label: 'claude_code', source: 'claude_code', auth_type: 'oauth', access_token: SECRET, expires_at_ms: now - 6 * 3600e3, last_status: 'dead', last_status_at: (now - 5 * 3600e3) / 1000, last_error_code: 401, last_error_reason: 'invalid_grant', last_error_message: 'Refresh token expired' }] } }));
  const f = path.join(cd, '.credentials.json');
  fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { accessToken: SECRET, ...(renew ? { refreshToken: SECRET } : {}), expiresAt: relogin ? now + 8 * 3600e3 : now - 6 * 3600e3, subscriptionType: 'max' } }));
  const t = new Date(relogin ? now : now - 6 * 3600e3); fs.utimesSync(f, t, t);
}
async function node(code, e) {
  const p = spawn(NODE, ['--input-type=module', '-e', code], { env: e, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  assert.equal(await new Promise(r => p.on('exit', r)), 0, err); return out;
}
const signin = async e => { const out = await node("import { agentSignin } from './lib/agent-signin.mjs'; import { CONFIG } from './lib/checks.mjs'; console.log(JSON.stringify(agentSignin(CONFIG)));", e); assert.ok(!out.includes(SECRET), 'never a token'); return JSON.parse(out); };
const listen = handler => new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
async function server(e) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const p = spawn(NODE, ['server.mjs'], { cwd: ROOT, env: { ...e, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const up = await new Promise(resolve => { let out = ''; const t = setTimeout(() => resolve(false), 5000); p.stdout.on('data', d => { out += d; if (out.includes(`:${port}/troubleshoot`)) { clearTimeout(t); resolve(true); } }); p.on('exit', () => { clearTimeout(t); resolve(false); }); });
    if (up) return { p, base: `http://127.0.0.1:${port}/troubleshoot/api/` };
    p.kill();
  }
  throw new Error('server did not start');
}
// A box whose services all answer: Tailscale, gateway, shell, Agent Service and Hermes /health are green.
async function box(state, reply) {
  const calls = { chat: 0 };
  const h = (q, r) => {
    const send = b => { r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify(b)); };
    if (q.url.startsWith('/localapi/')) return send({ BackendState: 'Running', Self: { DNSName: 'fixture.' } });
    if (q.url === '/health') return send({ status: 'ok', version: 'fixture' });
    if (q.url === '/wizard/health') return send({ status: 'ok', upstream_reachable: true, queue: { replies_not_started: 0, replies_not_started_s: 0, replies_given_up_15m: 0 } });
    if (q.url === '/v1/chat/completions') { calls.chat++; const [code, body] = reply(); r.statusCode = code; return send(body); }
    if (q.url.startsWith('/wizard-os-home/')) { r.setHeader('Content-Security-Policy', "frame-src 'self' https://fixture:9691; connect-src 'self' https://fixture:9691"); return r.end('ok'); }
    send({});
  };
  const api = await listen(h);
  const sock = path.join(state, 'ts.sock'); const ts = http.createServer(h); await new Promise(r => ts.listen(sock, r));
  const port = String(api.address().port);
  return { calls, close: () => { api.close(); ts.close(); }, env: { TS_SOCKET: sock, AGENT_PORT: port, HERMES_PORT: port, SHELL_PORT: port, GATEWAY_PORT: port } };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const status = async base => (await fetch(`${base}status?accounts=1`)).json();
// The page shares one status for 3 s; wait it out so the next read runs the checks again.
const later = async base => { await sleep(3100); return status(base); };
const check = (s, id) => s.checks.find(c => c.id === id);

test('the outage: the agent sign-in check is red, names the server sign-in and its fix, and shows no token', async () => {
  const e = env(tmp()); outage(e);
  const r = await signin(e);
  assert.equal(r.ok, false); assert.equal(r.state, 'expired'); assert.equal(r.provider, 'Claude'); assert.equal(r.login, 'server');
  assert.match(r.detail, /server sign-in your agent's Claude uses has expired/); assert.match(r.detail, /invalid_grant/);
  assert.equal(r.howToFix, TERMINAL); assert.equal(r.open, '');
});

test('signing in again on the server (a newer login file) turns it green; no renewal token and no file stay red', async () => {
  let e = env(tmp()); outage(e, { relogin: true });
  const ok = await signin(e); assert.equal(ok.ok, true); assert.match(ok.detail, /server sign-in \(max\)/);
  e = env(tmp()); outage(e, { renew: false }); assert.equal((await signin(e)).state, 'expired');
  e = env(tmp()); outage(e); fs.rmSync(path.join(e.HOME, '.claude/.credentials.json')); fs.writeFileSync(path.join(e.HOME, '.hermes/auth.json'), '{}');
  const none = await signin(e); assert.equal(none.state, 'missing'); assert.equal(none.howToFix, TERMINAL);
});

test('a Claude app bound to the agent login folder is the Claude app sign-in, fixed in the Claude app', async () => {
  const state = tmp(), e = env(state); outage(e);
  const o = path.join(state, 'runtipi/user-config/wizardapps/wizard-claude'); fs.mkdirSync(o, { recursive: true });
  fs.writeFileSync(path.join(o, 'docker-compose.yml'), `services:\n  wizard-claude-engine:\n    volumes:\n    - ${e.HOME}/.claude:/claude\nx-wizard-claude-login:\n  folder: ${e.HOME}/.claude\n  user: 0:0\n`);
  const r = await signin(e);
  assert.equal(r.login, 'claude-app'); assert.equal(r.open, '/wizard-claude/'); assert.match(r.detail, /Claude app sign-in .* has expired/); assert.match(r.howToFix, /Open the Claude app/);
});

test('other providers and unknown setups: a dead ChatGPT pool is red with the ChatGPT app fix; nothing to read is not an outage', async () => {
  let e = env(tmp()); const hh = path.join(e.HOME, '.hermes');
  fs.writeFileSync(path.join(hh, 'config.yaml'), 'model:\n  provider: openai-codex\n');
  fs.writeFileSync(path.join(hh, 'auth.json'), JSON.stringify({ credential_pool: { 'openai-codex': [{ source: 'device_code', access_token: SECRET, last_status: 'dead', last_error_reason: 'token_invalidated' }] } }));
  const c = await signin(e); assert.equal(c.ok, false); assert.equal(c.provider, 'ChatGPT'); assert.equal(c.open, '/wizard-chatgpt/');
  e = env(tmp()); assert.equal((await signin(e)).ok, true, 'no config: not checked');
  e = env(tmp(), { HERMES_PORT: '0', HERMES_CONTAINER: 'fixture' }); fs.writeFileSync(path.join(e.HOME, '.hermes/config.yaml'), 'model:\n  provider: anthropic\n');
  const fresh = await signin(e); assert.equal(fresh.ok, true); assert.equal(fresh.state, 'unknown');
});

test("Claude Code's own expired-login notices count as an expired sign-in", () => {
  for (const t of ['OAuth token has expired. Please obtain a new token or refresh your existing token.', 'Invalid API key · Please run /login']) assert.equal(providerFailure(t)?.state, 'expired', t);
  assert.equal(providerFailure('OK'), null);
});

test('the outage on the status page: down, named per login, no Claude app button, a reply check that ran by default', async () => {
  const state = tmp(); const b = await box(state, () => [500, { error: { message: "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in" } }]);
  const e = env(state, b.env); outage(e);
  const { p, base } = await server(e);
  try {
    const s = await status(base);
    assert.equal(s.overall, 'down');
    assert.equal(check(s, 'agent-signin').ok, false); assert.equal(check(s, 'agent-signin').howToFix, TERMINAL);
    assert.equal(check(s, 'agent-reply').ok, false, 'real reply check is on by default'); assert.equal(check(s, 'agent-reply').state, 'expired'); assert.equal(b.calls.chat, 1);
    for (const id of ['tailscale', 'gateway', 'shell', 'agent-service', 'hermes', 'replies-start']) assert.equal(check(s, id).ok, true, id);
    const claude = s.accounts.find(a => a.engine === 'claude');
    assert.equal(claude.app, 'Claude (server sign-in)'); assert.equal(claude.open, ''); assert.match(claude.detail, /server sign-in has expired\. Open a terminal on the server/);
    assert.equal(s.reconnect.server, true); assert.equal(s.reconnect.open, ''); assert.equal(s.reconnect.howToFix, TERMINAL);
    assert.ok(!JSON.stringify(s).includes(SECRET));
    const engines = await (await fetch(`${base}engines`)).json();
    assert.ok(!JSON.stringify(engines).includes('The Claude app has no sign-in'));
  } finally { p.kill(); b.close(); }
});

test('a working box: one tiny reply an hour, a fast failed run is red, and a new failure mark checks again at once', async () => {
  const state = tmp(); let reply = [200, { choices: [{ message: { content: 'OK' } }] }];
  const b = await box(state, () => reply);
  const e = env(state, b.env); outage(e, { relogin: true });
  const { p, base } = await server(e);
  try {
    let s = await status(base); assert.equal(s.overall, 'ok', JSON.stringify(s.checks.filter(c => !c.ok)));
    assert.equal(check(s, 'agent-reply').ok, true); assert.equal(check(s, 'agent-signin').ok, true); assert.equal(b.calls.chat, 1);
    await later(base); assert.equal(b.calls.chat, 1, 'no second message within the hour');
    // 59 minutes later: still the cached answer. 61 minutes later: one new reply.
    const f = path.join(state, 'reply-agent.json'), age = ms => { const c = JSON.parse(fs.readFileSync(f)); c.checkedAt = Date.now() - ms; fs.writeFileSync(f, JSON.stringify(c)); };
    age(59 * 60e3); await later(base); assert.equal(b.calls.chat, 1);
    reply = [500, { error: { message: 'upstream run failed' } }]; age(61 * 60e3);
    s = await later(base); assert.equal(b.calls.chat, 2); assert.equal(check(s, 'agent-reply').ok, false); assert.equal(check(s, 'agent-reply').skipped, false); assert.match(check(s, 'agent-reply').detail, /failed a real reply/);
    assert.equal(s.overall, 'down');
    // Healthy again; then Hermes marks its sign-in failed (an owner's chat just failed on it): checked again at once.
    reply = [200, { choices: [{ message: { content: 'OK' } }] }]; s = await (await fetch(`${base}status?fresh=1`)).json(); assert.equal(check(s, 'agent-reply').ok, true); assert.equal(b.calls.chat, 3);
    const auth = path.join(e.HOME, '.hermes/auth.json'), a = JSON.parse(fs.readFileSync(auth));
    a.credential_pool.anthropic[0].last_status = 'exhausted'; a.credential_pool.anthropic[0].last_status_at = Date.now() / 1000 + 5; fs.writeFileSync(auth, JSON.stringify(a));
    reply = [200, { choices: [{ message: { content: '' } }] }];
    s = await later(base); assert.equal(b.calls.chat, 4); assert.equal(check(s, 'agent-reply').ok, false, 'an empty answer is a failed reply');
  } finally { p.kill(); b.close(); }
});

test('the reply check never cries wolf when it cannot run, and TROUBLESHOOTER_REPLY_PROBES=0 turns it off', async () => {
  const closed = await listen(() => {}); const port = closed.address().port; await new Promise(r => closed.close(r));
  const state = tmp(); const e = env(state, { HERMES_PORT: String(port) }); // nothing listens: the Hermes check reports it
  const r = JSON.parse(await node("import { agentReply } from './lib/agent-reply.mjs'; import { CONFIG, run } from './lib/checks.mjs'; console.log(JSON.stringify(await agentReply(CONFIG, run)));", e));
  assert.equal(r.skipped, true);
  const ids = JSON.parse(await node("const { CHECKS } = await import('./lib/checks.mjs'); console.log(JSON.stringify(CHECKS.map(c => c.id)));", { ...e, TROUBLESHOOTER_REPLY_PROBES: '0' }));
  assert.ok(!ids.includes('agent-reply')); assert.ok(ids.includes('agent-signin'), 'the free sign-in check stays');
});

test('guardian: a dead agent sign-in is an outage, restarts nothing, and tells the owner the server steps', async () => {
  const state = tmp(); let repairs = 0;
  const b = await box(state, () => [500, { error: { message: 'No Anthropic credentials found' } }]);
  const api = await listen(async (q, r) => { for await (const _ of q) {} if (q.url === '/troubleshoot/api/guardian-repair') { repairs++; r.end(JSON.stringify({ id: '0123456789abcdef' })); } else r.end('{}'); });
  const e = env(state, { ...b.env, TROUBLESHOOT_PORT: String(api.address().port), GUARDIAN_THREAD: 'fixture-thread', TROUBLESHOOTER_REPLY_PROBES: '0' }); outage(e);
  const py = path.join(e.HOME, '.hermes/hermes-agent/venv/bin/python'); fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(py, `#!${NODE}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(path.join(state, 'reports'))}, fs.readFileSync(process.argv.at(-1),'utf8')+'\\n');\n`, { mode: 0o755 });
  try {
    const p = spawn(NODE, ['bin/guardian.mjs'], { cwd: ROOT, env: e, stdio: ['ignore', 'pipe', 'pipe'] }); let err = ''; p.stderr.on('data', d => err += d);
    assert.equal(await new Promise(r => p.on('exit', r)), 0, err);
    const incidents = fs.readFileSync(path.join(state, 'incidents.jsonl'), 'utf8');
    assert.match(incidents, /"kind":"outage"/); assert.doesNotMatch(incidents, /"kind":"auto-fix"/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'guardian.json'))).fixes, {});
    const reports = fs.readFileSync(path.join(state, 'reports'), 'utf8');
    assert.match(reports, /Wizard can't reply/); assert.match(reports, /run `claude`, then `\/login`/); assert.doesNotMatch(reports, /tap Sign in again/);
    assert.equal(repairs, 1); assert.equal(b.calls.chat, 0, 'off means no reply messages');
  } finally { api.close(); b.close(); }
});

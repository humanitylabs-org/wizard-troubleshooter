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
// Hermetic env: nothing below may read the host's real home, Tailscale socket, Agent Service releases (deploy.lock)
// or connection-app sign-ins, so the suite gives the same answer on a dev box, a live Wizard box and CI.
function hermetic(state, extra = {}) {
  const home = path.join(state, 'home');
  fs.mkdirSync(home, { recursive: true });
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(TROUBLESHOOT_|GUARDIAN_|WAS_|TS_|TAILSCALE_|GATEWAY_|AUTH_|SHELL_|AGENT_|HERMES_|CLAUDE_|CHATGPT_|TINFOIL_|WIZARD_|DOCKER_)/.test(k)) delete base[k];
  return { ...base, HOME: home, TROUBLESHOOT_STATE: state, TS_SOCKET: path.join(state, 'no-tailscale.sock'),
    WAS_RELEASE_ROOT: path.join(state, 'releases'), WAS_DEPLOY_BIN: path.join(state, 'no-deploy'),
    CLAUDE_CONFIG_DIR: path.join(state, 'no-claude'), CLAUDE_BIN: '/bin/false', CHATGPT_AUTH_FILE: path.join(state, 'none.json'),
    TINFOIL_URL: 'http://127.0.0.1:9', TINFOIL_TOKEN_FILE: path.join(state, 'none.json'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '',
    AUTH_PORT: '', DOCKER_BIN: '/bin/false', ...extra };
}

async function startServer(env) {
  // Port 0 would be simpler, but the service logs its port; wait for OUR process to say it is listening so a
  // parallel test file's server on a colliding random port can never answer in its place.
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(NODE, [path.join(APP, 'server.mjs')], { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const up = await new Promise(resolve => {
      let out = '';
      const t = setTimeout(() => resolve(false), 5000);
      child.stdout.on('data', d => { out += d; if (out.includes(`:${port}/troubleshoot`)) { clearTimeout(t); resolve(true); } });
      child.on('exit', () => { clearTimeout(t); resolve(false); });
    });
    if (up) return { port, child };
    child.kill();
  }
  throw new Error('server did not start');
}

test('owner gate: ping is open, everything else needs a real tailnet peer', async () => {
  const state = tmp();
  const { port, child } = await startServer(hermetic(state));
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
  fs.mkdirSync(path.join(state, 'claude'));
  fs.writeFileSync(path.join(state, 'claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600e3 } }));
  const { port, child } = await startServer(hermetic(state, { CLAUDE_CONFIG_DIR: path.join(state, 'claude') }));
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
    // Every engine fails (Claude exits, no ChatGPT/Tinfoil sign-in): the conversation must close honestly instead of hanging.
    let conv;
    for (let i = 0; i < 40; i++) { conv = JSON.parse(fs.readFileSync(path.join(state, 'conversations', `${id}.json`), 'utf8')); if (!conv.running) break; await new Promise(r => setTimeout(r, 100)); }
    assert.equal(conv.running, false);
    assert.ok(conv.events.some(e => e.type === 'note' && /Trying ChatGPT/.test(e.text)), 'falls back from Claude to ChatGPT');
    assert.equal(conv.events.at(-1).type, 'end');
  } finally { child.kill(); }
});

test('state-changing requests refuse other origins', async () => {
  const state = tmp();
  const { port, child } = await startServer(hermetic(state, { TROUBLESHOOT_DEV_NO_AUTH: '1' }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/troubleshoot/api/action`, { method: 'POST', body: JSON.stringify({ action: 'restart:hermes' }) });
    assert.equal(r.status, 403, 'missing X-Wizard-Troubleshoot header');
    const bad = await fetch(`http://127.0.0.1:${port}/troubleshoot/api/action`, { method: 'POST', headers: { 'X-Wizard-Troubleshoot': '1' }, body: JSON.stringify({ action: 'rm -rf /' }) });
    assert.equal(bad.status, 400, 'only named actions exist');
  } finally { child.kill(); }
});

test('guardian waits for consecutive failures before acting', () => {
  const state = tmp();
  const env = hermetic(state, { AGENT_PORT: '1', HERMES_PORT: '2', SHELL_PORT: '3', GATEWAY_PORT: '4' });
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

test('guardian waits while an Agent Service deploy holds deploy.lock (fixture lock, never the host one)', async () => {
  const state = tmp();
  const env = hermetic(state, { AGENT_PORT: '1', HERMES_PORT: '2', SHELL_PORT: '3', GATEWAY_PORT: '4' });
  fs.mkdirSync(env.WAS_RELEASE_ROOT, { recursive: true });
  const lock = path.join(env.WAS_RELEASE_ROOT, 'deploy.lock');
  const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore', detached: true });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(lock); i++) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 200));
    const out = execFileSync(NODE, [path.join(APP, 'bin/guardian.mjs'), '--dry-run'], { env, encoding: 'utf8' });
    assert.match(out, /update in progress/);
  } finally { process.kill(-holder.pid, 'SIGKILL'); }
  await new Promise(r => holder.exitCode !== null || holder.signalCode ? r() : holder.on('exit', r));
  const out = execFileSync(NODE, [path.join(APP, 'bin/guardian.mjs'), '--dry-run'], { env, encoding: 'utf8' });
  assert.doesNotMatch(out, /update in progress/, 'lock released: checks run again');
});

test('fresh layout: Hermes without a host port is judged by the Agent Service and restarted as its container', async () => {
  const state = tmp();
  const http = await import('node:http');
  let reachable = true;
  const agent = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ status: 'ok', upstream_reachable: reachable, queue: {} })); });
  await new Promise(r => agent.listen(0, '127.0.0.1', r));
  const env = hermetic(state, { AGENT_PORT: String(agent.address().port), HERMES_PORT: '0', HERMES_UNIT: '', HERMES_CONTAINER: 'hermes-agent_wizardapps-hermes-agent-engine-1', SHELL_PORT: '3', GATEWAY_PORT: '4' });
  const statusJson = () => new Promise((resolve, reject) => {
    const c = spawn(NODE, ['--input-type=module', '-e', "import { runChecks, ACTIONS, wiring } from './lib/checks.mjs'; const s = await runChecks(); console.log(JSON.stringify({ h: s.checks.find(c => c.id === 'hermes'), a: ACTIONS['restart:hermes'], w: wiring() }));"], { cwd: APP, env });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.on('exit', code => code ? reject(new Error('exit ' + code)) : resolve(JSON.parse(out)));
  });
  try {
    let r = await statusJson();
    assert.equal(r.h.ok, true);
    assert.deepEqual(r.a.cmd, ['/bin/false', ['restart', 'hermes-agent_wizardapps-hermes-agent-engine-1']]);
    assert.match(r.w, /no host port/);
    reachable = false;
    r = await statusJson();
    assert.equal(r.h.ok, false);
    assert.match(r.h.detail, /cannot reach/);
  } finally { agent.close(); }
});

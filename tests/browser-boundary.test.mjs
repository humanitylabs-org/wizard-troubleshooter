// Browser boundary (default-off): the Troubleshooter's own, distinct recovery gate (wizard-os #385 census row
// "troubleshooter"). Checked by this process alone, so it keeps working with the Agent Service, Hermes and the shell's
// backend down. node --test tests/browser-boundary.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-bb-'));
function env(state, extra = {}) {
  const base = { PATH: process.env.PATH, HOME: path.join(state, 'home') };
  fs.mkdirSync(base.HOME, { recursive: true });
  return { ...base, TROUBLESHOOT_STATE: state, TROUBLESHOOT_DEV_NO_AUTH: '1', TS_SOCKET: path.join(state, 'no.sock'),
    AGENT_PORT: '1', HERMES_PORT: '2', SHELL_PORT: '3', GATEWAY_PORT: '4', AUTH_PORT: '', TAILSCALE_UNIT: '', GATEWAY_UNIT: '', SHELL_CONTAINER: '', AGENT_UNIT: '', HERMES_UNIT: '',
    WAS_RELEASE_ROOT: path.join(state, 'releases'), WAS_DEPLOY_BIN: path.join(state, 'no-deploy'), CLAUDE_CONFIG_DIR: path.join(state, 'no-claude'), CLAUDE_BIN: '/bin/false',
    CODEX_BIN: '/bin/false', CODEX_HOME: path.join(state, 'no-codex'), CHATGPT_AUTH_FILE: path.join(state, 'none.json'), CHATGPT_BASE_URL: 'http://127.0.0.1:9',
    TINFOIL_URL: 'http://127.0.0.1:9', TINFOIL_TOKEN_FILE: path.join(state, 'none.json'), DOCKER_BIN: '/bin/false', WIZARD_APPS_FILE: path.join(state, 'no-apps.json'),
    WIZARD_PRIVATE_ORIGINS: 'https://box.example.ts.net', ...extra };
}
function start(e) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], { env: { ...e, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill(); reject(new Error('no start: ' + err)); }, 5000);
    child.stdout.on('data', d => { out += d; if (out.includes(`:${port}/troubleshoot`)) { clearTimeout(t); resolve({ port, child }); } });
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => { clearTimeout(t); resolve({ exited: code, err }); });
  });
}
// node:http so Host/Origin/Fetch Metadata are sent exactly as given (fetch() rewrites some of them).
function req(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/troubleshoot' + p, method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
async function box() {
  const state = tmp(), tokenFile = path.join(state, 'recovery.token');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  const s = await start(env(state, { WIZARD_BROWSER_BOUNDARY: '1', WIZARD_RECOVERY_TOKEN_FILE: tokenFile }));
  assert.ok(s.port, s.err);
  return { ...s, token, tokenFile, state };
}

test('boundary on without a recovery token file: the listener refuses to start (never runs ungated)', async () => {
  const state = tmp();
  const s = await start(env(state, { WIZARD_BROWSER_BOUNDARY: '1', WIZARD_RECOVERY_TOKEN_FILE: path.join(state, 'missing') }));
  assert.equal(s.exited, 2);
  assert.match(s.err, /WIZARD_RECOVERY_TOKEN_FILE/);
});

test('every api route needs the recovery token; frames, other sites and Origin:null are refused even with it', async () => {
  const t = await box();
  try {
    const T = { 'X-Wizard-Recovery-Token': t.token };
    assert.equal((await req(t.port, '/api/ping')).status, 200, 'reachability stays open');
    assert.equal((await req(t.port, '/api/status')).status, 403, 'no token');
    assert.deepEqual(JSON.parse((await req(t.port, '/api/status')).body), { error: 'recovery_token_required' });
    assert.equal((await req(t.port, '/api/status', { headers: { 'X-Wizard-Recovery-Token': 'f'.repeat(64) } })).status, 403, 'wrong token');
    assert.equal((await req(t.port, '/api/status', { headers: { ...T, 'Sec-Fetch-Site': 'same-origin' } })).status, 200, 'the shell / standalone page');
    for (const [h, why] of [[{ Origin: 'null' }, 'opaque frame'], [{ 'Sec-Fetch-Site': 'cross-site' }, 'another site'], [{ 'Sec-Fetch-Site': 'same-site' }, 'sibling site'], [{ 'Sec-Fetch-Dest': 'iframe' }, 'frame navigation']]) {
      assert.equal((await req(t.port, '/api/repairs?limit=5', { headers: { ...T, ...h } })).status, 403, why);
    }
    // Writes keep the old checks too: private Origin + X-Wizard-Troubleshoot, plus the token.
    const H = { Origin: 'https://box.example.ts.net', 'X-Wizard-Troubleshoot': '1', 'Sec-Fetch-Site': 'same-origin' };
    assert.equal((await req(t.port, '/api/engine', { method: 'POST', headers: H, body: { engine: 'chatgpt' } })).status, 403, 'write without token');
    assert.equal((await req(t.port, '/api/engine', { method: 'POST', headers: { ...H, ...T }, body: { engine: 'chatgpt' } })).status, 200, 'write with token');
    assert.equal((await req(t.port, '/api/engine', { method: 'POST', headers: { ...T, 'X-Wizard-Troubleshoot': '1', Origin: 'null' }, body: { engine: 'claude' } })).status, 403, 'Origin:null write');
    // Rotation applies without a restart.
    const next = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(t.tokenFile, next + '\n'); const later = new Date(Date.now() + 5000); fs.utimesSync(t.tokenFile, later, later);
    assert.equal((await req(t.port, '/api/status', { headers: T })).status, 403, 'old token after rotation');
    assert.equal((await req(t.port, '/api/status', { headers: { 'X-Wizard-Recovery-Token': next } })).status, 200, 'new token');
  } finally { t.child.kill(); }
});

test('the page: token only in a top-level navigation that cannot be framed or opened by another page; framed = opaque, no token', async () => {
  const t = await box();
  try {
    const top = await req(t.port, '/', { headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' } });
    assert.equal(top.status, 200);
    assert.ok(top.body.includes(`<meta name="wizard-recovery-token" content="${t.token}">`));
    assert.match(top.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(top.headers['x-frame-options'], 'DENY');
    assert.equal(top.headers['cross-origin-opener-policy'], 'noopener-allow-popups');
    assert.match(top.headers['cache-control'], /no-store/);
    const framed = await req(t.port, '/', { headers: { 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(framed.status, 200);
    assert.ok(!framed.body.includes(t.token) && !framed.body.includes('wizard-recovery-token" content'));
    assert.match(framed.headers['content-security-policy'], /sandbox allow-scripts allow-forms allow-downloads/);
    assert.ok(!/allow-same-origin/.test(framed.headers['content-security-policy']));
    for (const h of [{}, { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'no-cors' }, { 'Sec-Fetch-Dest': 'script', 'Sec-Fetch-Mode': 'no-cors' }]) {
      const r = await req(t.port, '/index.html', { headers: h });
      assert.equal(r.status, 403, JSON.stringify(h));
      assert.ok(!r.body.includes(t.token));
    }
  } finally { t.child.kill(); }
});

test('boundary off: the page and api behave exactly as before (no token, no new headers)', async () => {
  const state = tmp();
  const s = await start(env(state));
  try {
    const page = await req(s.port, '/');
    assert.equal(page.status, 200);
    assert.ok(!page.body.includes('wizard-recovery-token" content'));
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/);
    assert.ok(!/sandbox/.test(page.headers['content-security-policy']));
    assert.equal((await req(s.port, '/api/status')).status, 200);
  } finally { s.child.kill(); }
});

test('the gate is the troubleshooter\'s own: owner whois (tailscale-serve) still applies on top of the token', async () => {
  const state = tmp(), sock = path.join(state, 'ts.sock');
  const ts = http.createServer((q, r) => { const a = new URL(q.url, 'http://x').searchParams.get('addr'); if (a !== '100.70.0.1') { r.writeHead(404); return r.end(); } r.end(JSON.stringify({ Node: { User: 7, Tags: [] }, UserProfile: { ID: 7, LoginName: 'owner@example.com' } })); });
  await new Promise(r => ts.listen(sock, r));
  const tokenFile = path.join(state, 'recovery.token'), token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token);
  const s = await start(env(state, { TROUBLESHOOT_DEV_NO_AUTH: '', TROUBLESHOOT_FRONT: 'tailscale-serve', TS_WHOIS_SOCKET: sock, WIZARD_BROWSER_BOUNDARY: '1', WIZARD_RECOVERY_TOKEN_FILE: tokenFile }));
  try {
    assert.equal((await req(s.port, '/api/status', { headers: { 'X-Wizard-Recovery-Token': token } })).status, 403, 'token without a tailnet owner');
    assert.equal((await req(s.port, '/api/status', { headers: { 'X-Forwarded-For': '100.70.0.1' } })).status, 403, 'owner without token');
    assert.equal((await req(s.port, '/api/status', { headers: { 'X-Forwarded-For': '100.70.0.1', 'X-Wizard-Recovery-Token': token } })).status, 200, 'owner + token');
  } finally { s.child.kill(); ts.close(); }
});

test('under the boundary the shell check probes the shell server\'s health route, not its navigation-only document', async () => {
  const state = tmp();
  const read = extra => new Promise(r => { const c = spawn(process.execPath, ['--input-type=module', '-e', `const { CONFIG } = await import(${JSON.stringify(path.join(APP, 'lib/checks.mjs'))}); console.log(CONFIG.shellPath)`], { env: env(state, extra), stdio: ['ignore', 'pipe', 'ignore'] }); let o = ''; c.stdout.on('data', d => { o += d; }); c.on('exit', () => r(o.trim())); });
  assert.equal(await read({}), '/wizard-os-home/');
  assert.equal(await read({ WIZARD_BROWSER_BOUNDARY: '1' }), '/shell-health');
  assert.equal(await read({ WIZARD_BROWSER_BOUNDARY: '1', SHELL_PATH: '/custom/' }), '/custom/');
});

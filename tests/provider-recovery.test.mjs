// Sign-in recovery card under the browser owner boundary (wizard-os#133). The repair page asks this server whether
// the message that waited for a sign-in was sent again; this server asks the Agent Service box-local, with the shell
// token from WIZARD_SHELL_TOKEN_FILE when the box has one, and passes back only two flags.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-rec-'));
function hermetic(state, extra = {}) {
  const home = path.join(state, 'home');
  fs.mkdirSync(home, { recursive: true });
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(TROUBLESHOOT_|GUARDIAN_|WAS_|TS_|TAILSCALE_|GATEWAY_|AUTH_|SHELL_|AGENT_|HERMES_|CLAUDE_|CHATGPT_|TINFOIL_|WIZARD_|DOCKER_)/.test(k)) delete base[k];
  return { ...base, HOME: home, TROUBLESHOOT_STATE: state, TS_SOCKET: path.join(state, 'no-tailscale.sock'),
    WAS_RELEASE_ROOT: path.join(state, 'releases'), WAS_DEPLOY_BIN: path.join(state, 'no-deploy'),
    CLAUDE_CONFIG_DIR: path.join(state, 'no-claude'), CLAUDE_BIN: '/bin/false', CHATGPT_AUTH_FILE: path.join(state, 'none.json'),
    TINFOIL_URL: 'http://127.0.0.1:9', TINFOIL_TOKEN_FILE: path.join(state, 'none.json'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '',
    AUTH_PORT: '', DOCKER_BIN: '/bin/false', SHELL_WEB_DIR: path.join(state, 'no-shell'), TROUBLESHOOT_DEV_NO_AUTH: '1', ...extra };
}
async function startServer(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
// A stand-in Agent Service with the boundary on: provider-recovery answers only with the shell token.
async function fakeAgentService(token, runs) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/wizard/v1/provider-recovery') { res.writeHead(404); return res.end('{}'); }
    seen.push({ runId: u.searchParams.get('run_id'), headers: req.headers });
    if (req.headers['x-wizard-shell-token'] !== token) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"shell_token_required"}'); }
    const run = runs[u.searchParams.get('run_id')];
    if (!run) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"run_not_found"}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...run, private: 'never passed on' }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, seen };
}
const keyFrom = html => (html.match(/<meta name="wizard-troubleshoot-page" content="([^"]*)">/) || [])[1];
const TOKEN = 'ab'.repeat(32);

test('the sandboxed repair page learns the waiting message was sent, through this server with the shell token', async () => {
  const state = tmp();
  const tokFile = path.join(state, 'shell-token'); fs.writeFileSync(tokFile, TOKEN + '\n');
  const as = await fakeAgentService(TOKEN, { wizardq_sent: { status: 'completed', resent: true, sent: true }, wizardq_wait: { status: 'queued', resent: false, sent: false } });
  const s = await startServer(hermetic(state, { AGENT_PORT: String(as.port), WIZARD_SHELL_TOKEN_FILE: tokFile }));
  const base = `http://127.0.0.1:${s.port}/troubleshoot`;
  try {
    const key = keyFrom(await (await fetch(`${base}/`)).text());
    const ask = (id, h = { Origin: 'null', 'X-Wizard-Troubleshoot-Page': key }) => fetch(`${base}/api/provider-recovery?run_id=${encodeURIComponent(id)}`, { headers: h });
    let r = await ask('wizardq_sent');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'null');
    assert.deepEqual(await r.json(), { sent: true, resent: true }, 'only the two flags reach the page');
    r = await ask('wizardq_wait');
    assert.deepEqual(await r.json(), { sent: false, resent: false });
    const last = as.seen.at(-1);
    assert.equal(last.headers['x-wizard-shell-token'], TOKEN);
    assert.equal(last.headers.origin, undefined, 'a box-local call, never a browser one');
    assert.equal(last.headers['x-wizard-troubleshoot-page'], undefined, 'the page key stays here');
    // Top-level page (not sandboxed): same answer.
    assert.deepEqual(await (await fetch(`${base}/api/provider-recovery?run_id=wizardq_sent`)).json(), { sent: true, resent: true });
    assert.equal((await ask('wizardq_gone')).status, 404);
    // Refused before the Agent Service is asked: another sandboxed page (no key) and a malformed id.
    const before = as.seen.length;
    assert.equal((await ask('wizardq_sent', { Origin: 'null' })).status, 403);
    assert.equal((await ask('../../wizard/v1/bootstrap')).status, 400);
    assert.equal((await ask('')).status, 400);
    assert.equal(as.seen.length, before);
  } finally { s.child.kill(); as.srv.close(); fs.rmSync(state, { recursive: true, force: true }); }
});

test('turning the boundary on or off needs no restart: the token file is read on every call', async () => {
  const state = tmp();
  const tokFile = path.join(state, 'shell-token');
  const as = await fakeAgentService(TOKEN, { wizardq_sent: { status: 'completed', resent: true, sent: true } });
  const s = await startServer(hermetic(state, { AGENT_PORT: String(as.port), WIZARD_SHELL_TOKEN_FILE: tokFile }));
  const ask = () => fetch(`http://127.0.0.1:${s.port}/troubleshoot/api/provider-recovery?run_id=wizardq_sent`);
  try {
    assert.equal((await ask()).status, 502, 'no token file yet: the Agent Service refuses, the page hears "no answer"');
    assert.equal(as.seen.at(-1).headers['x-wizard-shell-token'], undefined);
    fs.writeFileSync(tokFile, TOKEN + '\n');
    assert.deepEqual(await (await ask()).json(), { sent: true, resent: true });
    fs.writeFileSync(tokFile, 'not-a-token\n');
    await ask();
    assert.equal(as.seen.at(-1).headers['x-wizard-shell-token'], undefined, 'a malformed file is never sent');
  } finally { s.child.kill(); as.srv.close(); fs.rmSync(state, { recursive: true, force: true }); }
});

test('the page asks its own server first and calls the Agent Service itself only when it is not sandboxed', () => {
  const page = fs.readFileSync(path.join(APP, 'web/index.html'), 'utf8');
  const poll = page.slice(page.indexOf('async function pollRecovery'), page.indexOf('setInterval(pollRecovery'));
  assert.ok(poll.indexOf('await api(q)') > 0 && poll.indexOf('await api(q)') < poll.indexOf("fetch('/wizard/v1/'"));
  assert.match(poll, /if \(sent === null && !pageKey\)/);
});

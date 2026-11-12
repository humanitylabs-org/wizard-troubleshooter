// Browser owner boundary (wizard-os#133): with the box switch on, the shell loads the repair page sandboxed, so its
// calls arrive with `Origin: null`. Only calls carrying the key from the page this server served may act or read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-sbx-'));
function hermetic(state, extra = {}) {
  const home = path.join(state, 'home');
  fs.mkdirSync(home, { recursive: true });
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(TROUBLESHOOT_|GUARDIAN_|WAS_|TS_|TAILSCALE_|GATEWAY_|AUTH_|SHELL_|AGENT_|HERMES_|CLAUDE_|CHATGPT_|TINFOIL_|WIZARD_|DOCKER_)/.test(k)) delete base[k];
  return { ...base, HOME: home, TROUBLESHOOT_STATE: state, TS_SOCKET: path.join(state, 'no-tailscale.sock'),
    WAS_RELEASE_ROOT: path.join(state, 'releases'), WAS_DEPLOY_BIN: path.join(state, 'no-deploy'),
    CLAUDE_CONFIG_DIR: path.join(state, 'no-claude'), CLAUDE_BIN: '/bin/false', CHATGPT_AUTH_FILE: path.join(state, 'none.json'),
    TINFOIL_URL: 'http://127.0.0.1:9', TINFOIL_TOKEN_FILE: path.join(state, 'none.json'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '',
    AUTH_PORT: '', DOCKER_BIN: '/bin/false', SHELL_WEB_DIR: path.join(state, 'no-shell'), ...extra };
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
const keyFrom = html => (html.match(/<meta name="wizard-troubleshoot-page" content="([^"]*)">/) || [])[1];

test('the served page carries a page key, and it survives a restart', async () => {
  const state = tmp();
  let s = await startServer(hermetic(state, { TROUBLESHOOT_DEV_NO_AUTH: '1' }));
  let key;
  try {
    const html = await (await fetch(`http://127.0.0.1:${s.port}/troubleshoot/`)).text();
    key = keyFrom(html);
    assert.match(key || '', /^[\w-]{43}$/);
    assert.ok(!html.includes('__TROUBLESHOOT_PAGE_KEY__'));
  } finally { s.child.kill(); }
  s = await startServer(hermetic(state, { TROUBLESHOOT_DEV_NO_AUTH: '1' }));
  try {
    assert.equal(keyFrom(await (await fetch(`http://127.0.0.1:${s.port}/troubleshoot/`)).text()), key, 'an open page keeps working after a restart');
  } finally { s.child.kill(); fs.rmSync(state, { recursive: true, force: true }); }
  const other = tmp(); s = await startServer(hermetic(other, { TROUBLESHOOT_DEV_NO_AUTH: '1' }));
  try {
    assert.notEqual(keyFrom(await (await fetch(`http://127.0.0.1:${s.port}/troubleshoot/`)).text()), key, 'each box has its own key');
  } finally { s.child.kill(); fs.rmSync(other, { recursive: true, force: true }); }
});

test('Origin: null calls need the page key; only then may the page read the answer', async () => {
  const state = tmp();
  const { port, child } = await startServer(hermetic(state, { TROUBLESHOOT_DEV_NO_AUTH: '1' }));
  const B = `http://127.0.0.1:${port}/troubleshoot`;
  try {
    const key = keyFrom(await (await fetch(`${B}/`)).text());
    const N = { Origin: 'null' };
    const J = { 'Content-Type': 'application/json', 'X-Wizard-Troubleshoot': '1' };

    // Preflight: tells the browser which headers it may send, nothing else.
    const pre = await fetch(`${B}/api/engine`, { method: 'OPTIONS', headers: { ...N, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-wizard-troubleshoot,x-wizard-troubleshoot-page' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'null');
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Wizard-Troubleshoot-Page/);
    assert.equal(await pre.text(), '');

    // Reads: refused without the key or with a wrong one; with it, readable by the sandboxed page.
    let r = await fetch(`${B}/api/incidents`, { headers: N });
    assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), null);
    r = await fetch(`${B}/api/incidents`, { headers: { ...N, 'X-Wizard-Troubleshoot-Page': 'x'.repeat(43) } });
    assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), null);
    r = await fetch(`${B}/api/incidents`, { headers: { ...N, 'X-Wizard-Troubleshoot-Page': key } });
    assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), 'null');
    assert.ok(Array.isArray((await r.json()).incidents));

    // Owner actions: another sandboxed page (no key) is refused; the repair page (key) is let through.
    r = await fetch(`${B}/api/engine`, { method: 'POST', headers: { ...N, ...J }, body: JSON.stringify({ engine: 'claude' }) });
    assert.equal(r.status, 403);
    r = await fetch(`${B}/api/action`, { method: 'POST', headers: { ...N, ...J }, body: JSON.stringify({ action: 'nope' }) });
    assert.equal(r.status, 403, 'a keyless sandboxed page never reaches an action');
    r = await fetch(`${B}/api/engine`, { method: 'POST', headers: { ...N, ...J, 'X-Wizard-Troubleshoot-Page': key }, body: JSON.stringify({ engine: 'claude' }) });
    assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), 'null');
    // The key does not replace the request header every page call carries.
    r = await fetch(`${B}/api/engine`, { method: 'POST', headers: { ...N, 'Content-Type': 'application/json', 'X-Wizard-Troubleshoot-Page': key }, body: '{}' });
    assert.equal(r.status, 403);

    // The key opens the API only; a null-origin read of the page itself is refused.
    r = await fetch(`${B}/`, { headers: { ...N, 'X-Wizard-Troubleshoot-Page': key } });
    assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), null);

    // Not sandboxed (switch off): same-origin calls get no CORS answer, as before.
    r = await fetch(`${B}/api/incidents`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), null);
  } finally { child.kill(); fs.rmSync(state, { recursive: true, force: true }); }
});

test('the page sends its key only when sandboxed, and drops it from the page', () => {
  const html = fs.readFileSync(path.join(APP, 'web/index.html'), 'utf8');
  assert.match(html, /<meta name="wizard-troubleshoot-page" content="__TROUBLESHOOT_PAGE_KEY__">/);
  assert.match(html, /self\.origin === 'null'/);
  assert.match(html, /m\.remove\(\)/);
  assert.match(html, /'X-Wizard-Troubleshoot-Page': pageKey/);
});

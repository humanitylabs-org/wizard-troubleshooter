// HTTP surface for owner-approved plans, screenshots and the self-contained page. Hermetic server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-plan-http-'));
function hermetic(state, extra = {}) {
  const home = path.join(state, 'home'); fs.mkdirSync(home, { recursive: true });
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(TROUBLESHOOT_|GUARDIAN_|WAS_|TS_|TAILSCALE_|GATEWAY_|AUTH_|SHELL_|AGENT_|HERMES_|CLAUDE_|CHATGPT_|TINFOIL_|WIZARD_|DOCKER_|REPAIR_)/.test(k)) delete base[k];
  const policy = path.join(state, 'policy.json'); // repair plans switched on, as on James's box
  if (!fs.existsSync(policy)) fs.writeFileSync(policy, JSON.stringify({ files: [], commands: {}, plans: true }));
  return { ...base, HOME: home, TROUBLESHOOT_STATE: state, REPAIR_POLICY_FILE: policy, TS_SOCKET: path.join(state, 'no.sock'), WAS_RELEASE_ROOT: path.join(state, 'r'), WAS_DEPLOY_BIN: path.join(state, 'no'),
    CLAUDE_CONFIG_DIR: path.join(state, 'no-claude'), CLAUDE_BIN: '/bin/false', CHATGPT_AUTH_FILE: path.join(state, 'none.json'), TINFOIL_URL: 'http://127.0.0.1:9',
    TINFOIL_TOKEN_FILE: path.join(state, 'none.json'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '', AUTH_PORT: '', DOCKER_BIN: '/bin/false', AGENT_PORT: '1', HERMES_PORT: '1', SHELL_PORT: '1', ...extra };
}
async function startServer(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const up = await new Promise(resolve => {
      let out = ''; const t = setTimeout(() => resolve(false), 5000);
      child.stdout.on('data', d => { out += d; if (out.includes(`:${port}/troubleshoot`) && (!env.TROUBLESHOOT_DIRECT_PORT || out.includes('Direct line'))) { clearTimeout(t); resolve(true); } });
      child.on('exit', () => { clearTimeout(t); resolve(false); });
    });
    if (up) return { port, child };
    child.kill();
  }
  throw new Error('server did not start');
}
const H = { 'Content-Type': 'application/json', 'X-Wizard-Troubleshoot': '1' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('page is self-contained: every render-blocking asset comes from this service, kit read from disk', async () => {
  const state = tmp(), web = path.join(state, 'shell-web');
  fs.mkdirSync(path.join(web, 'kit'), { recursive: true }); fs.mkdirSync(path.join(web, 'core'), { recursive: true });
  fs.writeFileSync(path.join(web, 'kit/wizard-tokens.css'), ':root{--wz-accent:#123456}');
  fs.writeFileSync(path.join(web, 'kit/wizard-ui.css'), '.wz-x{}'); fs.writeFileSync(path.join(web, 'core/app-client.js'), 'window.WizardApp={};');
  const { port, child } = await startServer(hermetic(state, { TROUBLESHOOT_DEV_NO_AUTH: '1', SHELL_WEB_DIR: web }));
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/troubleshoot/`)).text();
    const assets = [...html.matchAll(/<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"/g)].map(m => m[1]);
    assert.ok(assets.length >= 3);
    for (const a of assets) assert.match(a, /^\/troubleshoot\//, `${a} must not go through the Wizard shell`);
    const r = await fetch(`http://127.0.0.1:${port}/troubleshoot/kit/wizard-tokens.css`);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/css/); assert.match(await r.text(), /#123456/);
    assert.match(await (await fetch(`http://127.0.0.1:${port}/troubleshoot/kit/app-client.js`)).text(), /WizardApp/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/troubleshoot/kit/../server.mjs`)).status, 404);
  } finally { child.kill(); }
  // Shell files missing: still 200 with an empty kit, so the page paints in system colours.
  const s2 = tmp(); const b = await startServer(hermetic(s2, { TROUBLESHOOT_DEV_NO_AUTH: '1', SHELL_WEB_DIR: path.join(s2, 'none') }));
  try { const r = await fetch(`http://127.0.0.1:${b.port}/troubleshoot/kit/wizard-ui.css`); assert.equal(r.status, 200); assert.match(await r.text(), /unavailable/); } finally { b.child.kill(); }
});

test('plan endpoints: owner gate, request header, and approval only with the shown digest', async () => {
  const state = tmp();
  const gated = await startServer(hermetic(state));
  try {
    const r = await fetch(`http://127.0.0.1:${gated.port}/troubleshoot/api/plan/${'a'.repeat(16)}/approve`, { method: 'POST', headers: H, body: '{}' });
    assert.equal(r.status, 403, 'no tailnet peer, no approval');
  } finally { gated.child.kill(); }
  const env = hermetic(state, { TROUBLESHOOT_DEV_NO_AUTH: '1', REPAIR_HEALTH_URLS: '' });
  const { port, child } = await startServer(env);
  try {
    // Create the plan the way the model would (through the shared tool), in the server's state directory.
    process.env.TROUBLESHOOT_STATE = state;
    const { createPlan } = await import('../lib/repair-plan.mjs');
    const rec = createPlan({ title: 'Demo', diagnosis: 'd', steps: [{ action: 'run', command: 'true' }] });
    const got = await (await fetch(`http://127.0.0.1:${port}/troubleshoot/api/plan/${rec.id}`)).json();
    assert.equal(got.state, 'proposed'); assert.equal(got.digest, rec.digest);
    assert.equal((await fetch(`http://127.0.0.1:${port}/troubleshoot/api/plan/${rec.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest: rec.digest }) })).status, 403, 'needs the page header');
    assert.equal((await fetch(`http://127.0.0.1:${port}/troubleshoot/api/plan/${rec.id}/approve`, { method: 'POST', headers: H, body: JSON.stringify({ digest: '0'.repeat(64) }) })).status, 409);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/troubleshoot/api/plan/${rec.id}`)).json()).state, 'proposed');
  } finally { child.kill(); }
});

test('approving a plan needs an owner list and a connection from the HTTPS front, not any local process', async () => {
  const src = fs.readFileSync(path.join(APP, 'server.mjs'), 'utf8');
  assert.match(src, /if \(!OWNERS\.size\) return 'Repair plans need TROUBLESHOOT_OWNERS/);
  assert.match(src, /if \(!await frontProcess\(req\)\) return 'Approve repairs from your Wizard address/);
  assert.match(src, /selfIPs\.has\(ip\)/, 'the box itself coming back through the front never approves');
  assert.match(src, /const refused = pm\[2\] !== 'dismiss' && await planGate\(who, req\)/);
});

test('screenshots are stored with the owner message and served back only as images', async () => {
  const state = tmp();
  const { port, child } = await startServer(hermetic(state, { TROUBLESHOOT_DEV_NO_AUTH: '1' }));
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/troubleshoot/api/repair`, { method: 'POST', headers: H, body: JSON.stringify({ message: 'x', images: [{ dataUrl: 'data:text/html;base64,PGI+' }] }) });
    assert.equal(bad.status, 400);
    const r = await fetch(`http://127.0.0.1:${port}/troubleshoot/api/repair`, { method: 'POST', headers: H, body: JSON.stringify({ message: 'It looks like this', engine: 'claude', images: [{ dataUrl: PNG, name: 'shot.png' }] }) });
    assert.equal(r.status, 202);
    const { id } = await r.json();
    let conv;
    for (let i = 0; i < 40; i++) { conv = await (await fetch(`http://127.0.0.1:${port}/troubleshoot/api/repair/${id}`)).json(); if (!conv.running) break; await new Promise(r => setTimeout(r, 250)); }
    const owner = conv.events.find(e => e.type === 'text' && e.role === 'owner');
    assert.equal(owner.images.length, 1); assert.equal(owner.images[0].type, 'image/png');
    const img = await fetch(`http://127.0.0.1:${port}/troubleshoot/api/attachment/${id}/${owner.images[0].id}`);
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), PNG.split(',')[1]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/troubleshoot/api/attachment/${id}/${'0'.repeat(16)}`)).status, 404);
  } finally { child.kill(); }
});

test('direct line: a second listener for Tailscale Serve trusts only its forwarded peer, and status advertises it', async () => {
  const state = tmp(), direct = 20000 + Math.floor(Math.random() * 20000);
  const { port, child } = await startServer(hermetic(state, { TROUBLESHOOT_DIRECT_PORT: String(direct), TROUBLESHOOT_DIRECT_URL: 'https://box.example.ts.net:9691' }));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${direct}/troubleshoot/api/ping`)).status, 200);
    // No forwarded peer (or one whois can't confirm): refused, exactly like the main listener.
    assert.equal((await fetch(`http://127.0.0.1:${direct}/troubleshoot/api/status`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${direct}/troubleshoot/api/status`, { headers: { 'X-Forwarded-For': '100.64.0.9' } })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/troubleshoot/api/status`, { headers: { 'X-Forwarded-For': '100.64.0.9' } })).status, 403);
  } finally { child.kill(); }
  const s2 = tmp(), d2 = 20000 + Math.floor(Math.random() * 20000);
  const b = await startServer(hermetic(s2, { TROUBLESHOOT_DEV_NO_AUTH: '1', WIZARD_PUBLIC_NAME: 'box.example.ts.net', TROUBLESHOOT_DIRECT_PORT: String(d2), TROUBLESHOOT_DIRECT_URL: 'https://box.example.ts.net:9691' }));
  try {
    const s = await (await fetch(`http://127.0.0.1:${d2}/troubleshoot/api/status`)).json();
    assert.equal(s.direct, 'https://box.example.ts.net:9691/troubleshoot/');
    // The shell's origin may frame the direct line (its fallback when /troubleshoot/ on the gateway is down).
    const csp = (await fetch(`http://127.0.0.1:${d2}/troubleshoot/`)).headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'self' https:\/\/box\.example\.ts\.net(?:;|$)/);
  } finally { b.child.kill(); }
});

// Repair plans are switched off by default (#37). The switch is the existing per-box repair policy
// (REPAIR_POLICY_FILE): without "plans": true the model gets no plan tools, nothing can be approved, the executor
// refuses, and the HTTP approve route says so. Hermetic: throwaway HOME, state and policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'repair-plan-switch-'));
const HOME = path.join(root, 'home'); fs.mkdirSync(HOME, { recursive: true });
const STATE = path.join(root, 'state');
const POLICY = path.join(root, 'policy.json');
process.env.HOME = HOME;
process.env.TROUBLESHOOT_STATE = STATE;
process.env.REPAIR_HEALTH_URLS = '';
delete process.env.REPAIR_POLICY_FILE;
const P = await import('../lib/repair-plan.mjs');
const { toolDefs, callTool } = await import('../lib/toolloop.mjs');
const launched = [];
P.setLauncher(x => { launched.push(x); return { via: 'test' }; });
const policy = v => { if (v === null) delete process.env.REPAIR_POLICY_FILE; else { fs.writeFileSync(POLICY, JSON.stringify(v)); process.env.REPAIR_POLICY_FILE = POLICY; } };
const names = () => toolDefs().map(t => t.name);
const PLAN_TOOLS = ['inspect_file', 'list_dir', 'search_text', 'propose_repair'];
const plan = { title: 'Demo', diagnosis: 'd', steps: [{ action: 'run', command: 'true' }] };

test('off by default: no policy, a policy without plans, or plans other than true', async () => {
  for (const v of [null, { files: [], commands: {} }, { files: [], commands: {}, plans: 'yes' }, { files: [], commands: {}, plans: 1 }]) {
    policy(v);
    assert.equal(P.plansOn(), false, JSON.stringify(v));
    assert.ok(PLAN_TOOLS.every(n => !names().includes(n)), 'no plan tool reaches any model');
    assert.ok(['check_status', 'run_fix', 'repair_scope'].every(n => names().includes(n)), 'existing tools stay');
    assert.match(await callTool('propose_repair', JSON.stringify(plan), { engine: 'claude' }), /Unknown tool|unknown tool|not allowed|Error/i);
    assert.match(await P.planTool('propose_repair', plan), /switched off/);
  }
  fs.writeFileSync(POLICY, '{not json'); process.env.REPAIR_POLICY_FILE = POLICY;
  assert.equal(P.plansOn(), false, 'an unreadable policy is off');
});

test('switched on: the model gets the plan tools; switched off again: a proposed plan cannot be approved', async () => {
  policy({ files: [], commands: {}, plans: true });
  assert.equal(P.plansOn(), true);
  assert.ok(PLAN_TOOLS.every(n => names().includes(n)));
  const out = JSON.parse(await callTool('propose_repair', JSON.stringify(plan), { engine: 'claude', convId: 'c'.repeat(16) }));
  assert.equal(out.proposed, true);
  const rec = P.planState(out.plan);
  policy({ files: [], commands: {} });
  assert.throws(() => P.approvePlan(rec.id, rec.digest, 'owner'), e => e.status === 403 && /switched off/.test(e.message));
  assert.equal(launched.length, 0);
  assert.equal(P.planState(rec.id).state, 'proposed');
  // Even a forged approval file does not make the executor run while the switch is off.
  fs.writeFileSync(path.join(P.PLANS, rec.id, 'approval.json'), JSON.stringify({ by: 'x', at: new Date().toISOString(), digest: rec.digest }));
  const r = spawnSync(process.execPath, [path.join(APP, 'bin/execute-plan.mjs'), path.join(P.PLANS, rec.id)], { env: { ...process.env }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 3);
  assert.match(fs.readFileSync(path.join(P.PLANS, rec.id, 'transcript.log'), 'utf8'), /switched off/);
  policy({ files: [], commands: {}, plans: true });
  assert.equal(P.approvePlan(P.createPlan(plan).id, P.listPlans()[0].digest, 'owner').approved, true);
  assert.equal(launched.length, 1);
});

function hermetic(state, extra = {}) {
  const home = path.join(state, 'home'); fs.mkdirSync(home, { recursive: true });
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(TROUBLESHOOT_|GUARDIAN_|WAS_|TS_|TAILSCALE_|GATEWAY_|AUTH_|SHELL_|AGENT_|HERMES_|CLAUDE_|CHATGPT_|TINFOIL_|WIZARD_|DOCKER_|REPAIR_)/.test(k)) delete base[k];
  return { ...base, HOME: home, TROUBLESHOOT_STATE: state, TS_SOCKET: path.join(state, 'no.sock'), WAS_RELEASE_ROOT: path.join(state, 'r'), WAS_DEPLOY_BIN: path.join(state, 'no'),
    CLAUDE_CONFIG_DIR: path.join(state, 'no-claude'), CLAUDE_BIN: '/bin/false', CHATGPT_AUTH_FILE: path.join(state, 'none.json'), TINFOIL_URL: 'http://127.0.0.1:9',
    TINFOIL_TOKEN_FILE: path.join(state, 'none.json'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '', AUTH_PORT: '', DOCKER_BIN: '/bin/false', AGENT_PORT: '1', HERMES_PORT: '1', SHELL_PORT: '1', REPAIR_HEALTH_URLS: '', ...extra };
}
async function startServer(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(APP, 'server.mjs')], { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const up = await new Promise(resolve => {
      let out = ''; const t = setTimeout(() => resolve(false), 5000);
      child.stdout.on('data', d => { out += d; if (out.includes(`:${port}/troubleshoot`)) { clearTimeout(t); resolve(true); } });
      child.on('exit', () => { clearTimeout(t); resolve(false); });
    });
    if (up) return { port, child };
    child.kill();
  }
  throw new Error('server did not start');
}
const H = { 'Content-Type': 'application/json', 'X-Wizard-Troubleshoot': '1' };

test('HTTP: owner gate and page header; approve refused while off and with a wrong digest while on', async () => {
  const state = path.join(root, 'http-state'); fs.mkdirSync(state, { recursive: true });
  const pol = path.join(root, 'http-policy.json');
  fs.writeFileSync(pol, JSON.stringify({ files: [], commands: {}, plans: true }));
  const gated = await startServer(hermetic(state, { REPAIR_POLICY_FILE: pol }));
  try {
    const r = await fetch(`http://127.0.0.1:${gated.port}/troubleshoot/api/plan/${'a'.repeat(16)}/approve`, { method: 'POST', headers: H, body: '{}' });
    assert.equal(r.status, 403, 'no tailnet peer, no approval');
  } finally { gated.child.kill(); }
  // The plan is created in the server's state dir, the way the model's tool call would.
  const mk = spawnSync(process.execPath, ['--input-type=module', '-e', `import { createPlan } from ${JSON.stringify(path.join(APP, 'lib/repair-plan.mjs'))}; console.log(JSON.stringify(createPlan(${JSON.stringify(plan)})));`],
    { env: hermetic(state, { REPAIR_POLICY_FILE: pol }), encoding: 'utf8', timeout: 20000 });
  const rec = JSON.parse(mk.stdout.trim().split('\n').pop());
  const { port, child } = await startServer(hermetic(state, { TROUBLESHOOT_DEV_NO_AUTH: '1', REPAIR_POLICY_FILE: pol }));
  const u = s => `http://127.0.0.1:${port}/troubleshoot/api/${s}`;
  try {
    const got = await (await fetch(u(`plan/${rec.id}`))).json();
    assert.equal(got.state, 'proposed'); assert.equal(got.digest, rec.digest);
    assert.equal((await (await fetch(u('plans'))).json()).on, true);
    assert.equal((await fetch(u(`plan/${rec.id}/approve`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest: rec.digest }) })).status, 403, 'needs the page header');
    { const w = await fetch(u(`plan/${rec.id}/approve`), { method: 'POST', headers: H, body: JSON.stringify({ digest: '0'.repeat(64) }) }); assert.equal(w.status, 409, await w.text()); }
    fs.writeFileSync(pol, JSON.stringify({ files: [], commands: {} })); // switched off live, no restart
    assert.equal((await (await fetch(u('plans'))).json()).on, false);
    const off = await fetch(u(`plan/${rec.id}/approve`), { method: 'POST', headers: H, body: JSON.stringify({ digest: rec.digest }) });
    assert.equal(off.status, 403); assert.match((await off.json()).error, /switched off/);
    assert.equal((await (await fetch(u(`plan/${rec.id}`))).json()).state, 'proposed');
  } finally { child.kill(); }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

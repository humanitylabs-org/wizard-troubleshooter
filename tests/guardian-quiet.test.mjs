// #68 (26 Nov 2026): the guardian posted about 37 messages into James's chat in 19 hours over one false alarm, most of
// them "Wizard fixed itself" above "still not working". He asked: "Please do not put these in my inbox if nothing is
// needed from me." The thread now hears only what the owner must act on, once per problem; the rest is the incident
// log. The false alarm itself (#69): the app-address check had remembered Finances at `/` during a rename.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
process.env.TROUBLESHOOT_STATE ||= fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'gq-'));
const { postDue, stuckText } = await import('../bin/guardian.mjs');
const ROOT = path.resolve(import.meta.dirname, '..'), HOUR = 3600e3;
const RAW = 'https://box.fixture.ts.net:9300/';

const listen = (h, where) => new Promise(r => { const s = http.createServer(h); where ? s.listen(where, () => r(s)) : s.listen(0, '127.0.0.1', () => r(s)); });

// A healthy fake box (every link answers) with an app registry, a fake `wam links`, a fake thread poster and a fake
// Troubleshooter API for the repair chat. Only the app-address check can fail.
async function box(t, { registered, remembered, wamFixes = false }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'gq-box-'));
  const state = path.join(dir, 'state'), home = path.join(dir, 'home'), woh = path.join(home, '.wizard-os'), runtipi = path.join(dir, 'runtipi');
  for (const d of [state, woh, path.join(runtipi, 'app-data/wizard-os'), path.join(home, '.hermes/hermes-agent/venv/bin')]) fs.mkdirSync(d, { recursive: true });
  const app = (id, url) => ({ id, name: id[0].toUpperCase() + id.slice(1), status: 'running', view: { url, local: 'http://127.0.0.1:9300/' } });
  const regs = [path.join(woh, 'apps.json'), path.join(runtipi, 'app-data/wizard-os/apps.json')];
  for (const f of regs) fs.writeFileSync(f, JSON.stringify({ apps: [app('finances', registered), app('files', '/files/')] }));
  fs.writeFileSync(path.join(woh, 'links.json'), JSON.stringify({ links: [{ id: 'files', open: '/files/' }], errors: {} }));
  fs.writeFileSync(path.join(state, 'launchers.json'), JSON.stringify({ paths: { finances: remembered, files: '/files/' } }));
  const wam = path.join(dir, 'wam');
  fs.writeFileSync(wam, `#!${process.execPath}
const fs = require('fs');
if (${wamFixes}) for (const p of ${JSON.stringify(regs)}) { const r = JSON.parse(fs.readFileSync(p, 'utf8')); r.apps[0].view.url = '/money/'; fs.writeFileSync(p, JSON.stringify(r)); }
// A wam that can't fix it reports why (#69: a clean run that changes nothing means the memory is stale, not an outage).
console.log(JSON.stringify({ links: [], errors: ${wamFixes} ? {} : { finances: 'kept: existing Serve route differs' } }));
process.exit(${wamFixes} ? 0 : 1);
`, { mode: 0o755 });
  const reports = path.join(dir, 'reports');
  fs.writeFileSync(path.join(home, '.hermes/hermes-agent/venv/bin/python'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(reports)}, '=== post\\n'+fs.readFileSync(process.argv.at(-1),'utf8')+'\\n');\n`, { mode: 0o755 });
  const calls = { repairs: 0 };
  const h = (q, r) => {
    const send = b => { r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify(b)); };
    if (q.url === '/troubleshoot/api/guardian-repair') { calls.repairs++; q.resume(); return send({ id: 'feedfacecafe0001' }); }
    if (q.url.startsWith('/localapi/')) return send({ BackendState: 'Running', Self: { DNSName: 'fixture.' } });
    if (q.url === '/health') return send({ status: 'ok' });
    if (q.url === '/wizard/health') return send({ status: 'ok', upstream_reachable: true, queue: { replies_not_started: 0, replies_not_started_s: 0, replies_given_up_15m: 0 } });
    if (q.url.startsWith('/wizard-os-home/')) { r.setHeader('Content-Security-Policy', "frame-src 'self' https://fixture:9691; connect-src 'self' https://fixture:9691"); return r.end('ok'); }
    send({});
  };
  const api = await listen(h), sock = path.join(dir, 'ts.sock'), ts = await listen(h, sock);
  t.after(() => { api.close(); ts.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = String(api.address().port);
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, TROUBLESHOOT_STATE: state, TS_SOCKET: sock, AGENT_PORT: port, HERMES_PORT: port, SHELL_PORT: port,
    GATEWAY_PORT: port, TROUBLESHOOT_PORT: port, AUTH_PORT: '', TAILSCALE_UNIT: '', GATEWAY_UNIT: '', SHELL_CONTAINER: '', AGENT_UNIT: '', HERMES_UNIT: '', RUN_KEEPER_UNIT: '',
    TROUBLESHOOT_UNIT: '', WAS_RELEASE_ROOT: path.join(dir, 'no-release'), WAS_DEPLOY_BIN: path.join(dir, 'no-deploy'), DOCKER_BIN: '/bin/false', RUNTIPI_ROOT: runtipi,
    WIZARD_OS_HOME: woh, WAM_BIN: wam, TROUBLESHOOTER_REPLY_PROBES: '0', GUARDIAN_THREAD: 'fixture-thread', GUARDIAN_TZ: 'UTC' };
  const minute = async preset => {
    if (preset) fs.writeFileSync(path.join(state, 'guardian.json'), JSON.stringify(preset));
    const p = spawn(process.execPath, ['bin/guardian.mjs'], { cwd: ROOT, env }); let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    assert.equal(await new Promise(r => p.on('close', r)), 0, err);
    return JSON.parse(out.trim().split('\n').pop());
  };
  const posts = () => fs.existsSync(reports) ? fs.readFileSync(reports, 'utf8').split('=== post\n').filter(Boolean) : [];
  const incidents = () => fs.existsSync(path.join(state, 'incidents.jsonl')) ? fs.readFileSync(path.join(state, 'incidents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const saved = () => JSON.parse(fs.readFileSync(path.join(state, 'guardian.json'), 'utf8'));
  const remembers = () => JSON.parse(fs.readFileSync(path.join(state, 'launchers.json'), 'utf8')).paths;
  return { minute, posts, incidents, saved, remembers, calls, state };
}

test('the Finances case: remembered `/`, registered `/money/` passes, re-learns `/money/`, and posts nothing', async t => {
  const b = await box(t, { registered: '/money/', remembered: '/' });
  for (let i = 0; i < 3; i++) assert.deepEqual((await b.minute()).failing, []);
  assert.equal(b.remembers().finances, '/money/');
  assert.deepEqual(b.posts(), []);
  assert.deepEqual(b.incidents(), [], 'no outage, no restart, no repair');
  assert.equal(b.calls.repairs, 0);
});

test('a check fails and a restart recovers it: zero thread posts, one outage in the log', async t => {
  const b = await box(t, { registered: RAW, remembered: '/money/', wamFixes: true });
  const sum = await b.minute({ fails: { 'app-addresses': 1 }, fixes: {}, outage: null, lastAiRepair: 0, rolledBack: {} });
  assert.deepEqual(sum.actions, ['restart:app-addresses:true']);
  assert.deepEqual(b.posts(), [], 'nothing for the owner to do: nothing in his chat');
  const inc = b.incidents();
  assert.equal(inc.filter(i => i.kind === 'outage').length, 1);
  assert.equal(inc.filter(i => i.kind === 'recovered').length, 1);
  assert.ok(!inc.some(i => /fixed itself/i.test(i.text || '')));
  assert.equal(b.saved().outage, null);
});

test('restarts and the repair chat do not clear it for 24 h: exactly one post, naming the one thing to do', async t => {
  const b = await box(t, { registered: RAW, remembered: '/money/' });
  const now = Date.now();
  // Hour after hour of failed restarts and repairs: nothing reaches the owner while it is under a day old.
  let s = { fails: { 'app-addresses': 30 }, fixes: {}, outage: { since: now - 23 * HOUR, first: ['x'] }, lastAiRepair: 0, rolledBack: {} };
  await b.minute(s); await b.minute();
  assert.ok(b.calls.repairs >= 1, 'the repair chat was asked');
  assert.deepEqual(b.posts(), [], 'under a day: incident log only');
  // A day in: one post. Every later minute (and hour) of the same outage: no more.
  s = { ...b.saved(), outage: { ...b.saved().outage, since: now - 25 * HOUR }, lastFix: {}, restartHold: {}, fixes: {} };
  await b.minute(s);
  for (let i = 0; i < 3; i++) await b.minute({ ...b.saved(), lastFix: {}, restartHold: {}, fixes: {}, lastAiRepair: 0 });
  const posts = b.posts();
  assert.equal(posts.length, 1, posts.join('\n'));
  assert.match(posts[0], /Apps open inside Wizard has not been working for 25 hours, and Wizard could not fix it by itself/);
  assert.match(posts[0], /Open the Troubleshooter and tell its repair chat what you see: \/troubleshoot\//);
  assert.doesNotMatch(posts[0], /fixed itself/);
  assert.equal(b.incidents().filter(i => i.kind === 'owner-asked').length, 1);
});

test('a repair plan waiting for the owner is the one thing the 24 h post names', async t => {
  const b = await box(t, { registered: RAW, remembered: '/money/' });
  const dir = path.join(b.state, 'repair-plans', '70d579d17dd717cc'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ id: '70d579d17dd717cc', convId: 'feedfacecafe0001', createdAt: new Date().toISOString(), digest: 'x',
    plan: { title: 'Correct the remembered Finances address', diagnosis: 'stale', steps: [{ action: 'run', command: 'true' }] } }));
  await b.minute({ fails: { 'app-addresses': 30 }, fixes: {}, outage: { since: Date.now() - 25 * HOUR, first: ['x'] }, lastAiRepair: Date.now(), rolledBack: {} });
  const [post, ...more] = b.posts();
  assert.equal(more.length, 0);
  assert.match(post, /A repair is ready and needs your OK: open the Troubleshooter and tap Approve and run on "Correct the remembered Finances address": \/troubleshoot\/#r=feedfacecafe0001/);
});

test('one post per problem: once per outage, and not again within a day when it comes back', () => {
  const now = Date.now();
  assert.equal(postDue({}, 'signin', now), true);
  assert.equal(postDue({ outage: { told: ['signin'] } }, 'signin', now + 3 * 24 * HOUR), false, 'never twice in one outage');
  assert.equal(postDue({ posted: { signin: now } }, 'signin', now + 23 * HOUR), false);
  assert.equal(postDue({ posted: { signin: now } }, 'signin', now + 25 * HOUR), true);
  assert.equal(postDue({ posted: { signin: now } }, 'down-app-addresses', now), true, 'another problem is its own post');
  assert.match(stuckText(['Agent Service', 'Secure gateway'], 24, null), /^\*\*Agent Service, Secure gateway have not been working for 24 hours, and Wizard could not fix them by itself\.\*\*/);
});

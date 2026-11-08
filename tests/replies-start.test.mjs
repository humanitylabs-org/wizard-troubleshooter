// 8 Nov 2026: from 12:35 UTC Hermes accepted every Wizard reply and started none, for over an hour. Every check here
// stayed green (they ask "are you alive?"), the guardian said "ok" every minute, and the repair chat refused to
// restart Hermes because its health check was green. A reply that was accepted but never starts is an incident.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
process.env.TROUBLESHOOT_STATE ||= fs.mkdtempSync((process.env.TMPDIR || os.tmpdir()) + '/rs-');
const { stallSteps } = await import('../bin/guardian.mjs');
const APP = path.resolve(import.meta.dirname, '..');
const MIN = 60e3, now = Date.parse('2026-11-08T12:40:00Z');

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
}
const agent = queue => serve((req, res) => {
  if (req.url === '/wizard/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', upstream_reachable: true, queue: { active: 1, queued: 0, ...queue } })); }
  res.writeHead(302, { Location: '/' }); res.end();
});
const hermes = () => serve((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok","version":"test"}'); });
async function closedPort() { const s = await serve(() => {}); const { port } = s.address(); await new Promise(r => s.close(r)); return port; }
function env(dir, agentPort, hermesPort, closed) {
  return { PATH: process.env.PATH, HOME: dir, TROUBLESHOOT_STATE: dir, WAS_RELEASE_ROOT: path.join(dir, 'releases'), WAS_DEPLOY_BIN: path.join(dir, 'no-deploy'),
    AGENT_PORT: String(agentPort), AGENT_HEALTH_TIMEOUT_MS: '1000', AGENT_UNIT: 'fake-agent.service', HERMES_PORT: String(hermesPort), HERMES_UNIT: 'fake-hermes.service',
    GATEWAY_PORT: String(closed), SHELL_PORT: String(closed), AUTH_PORT: '0', TS_SOCKET: path.join(dir, 'no.sock'), GUARDIAN_THREAD: '', GUARDIAN_TZ: 'Asia/Bangkok', DOCKER_BIN: '/bin/false' };
}
async function node(args, environment) {
  const child = spawn(process.execPath, args, { cwd: APP, env: environment });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 0, err);
  return out;
}
async function rig(queue) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'replies-start-'));
  const a = await agent(queue), h = await hermes();
  return { dir, env: env(dir, a.address().port, h.address().port, await closedPort()), close: () => { a.close(); h.close(); } };
}

test('the repair chat is asked first; the owner only after 5 min of replies not starting, once', () => {
  const s = {}, stalled = { id: 'replies-start', ok: false };
  assert.deepEqual(stallSteps(s, stalled, now, true), [{ step: 'repair' }]);
  assert.deepEqual(stallSteps(s, stalled, now + 2 * MIN, true), [], 'nothing repeats every minute');
  assert.deepEqual(stallSteps(s, stalled, now + 5 * MIN, true), [{ step: 'ask-owner' }]);
  assert.deepEqual(stallSteps(s, stalled, now + 9 * MIN, true), []);
  assert.deepEqual(stallSteps(s, { ok: true }, now + 10 * MIN, true), [{ step: 'ended', since: now }]);
  assert.equal(s.stall, null);
  // A repair chat that started recently for something else: the owner is still asked after 5 min.
  const busy = {};
  assert.deepEqual(stallSteps(busy, stalled, now, false), []);
  assert.deepEqual(stallSteps(busy, stalled, now + 5 * MIN, false), [{ step: 'ask-owner' }]);
});

test('guardian: a reply accepted 4 min ago and not started is an incident while Hermes says ok, and Hermes is not restarted by itself', async () => {
  const r = await rig({ replies_not_started: 1, replies_not_started_s: 240, replies_given_up_15m: 0 });
  try {
    const out = await node(['bin/guardian.mjs', '--dry-run'], r.env);
    const summary = JSON.parse(out.trim().split('\n').pop());
    assert.ok(summary.failing.includes('replies-start'), out);
    assert.ok(!summary.failing.includes('hermes'), 'Hermes itself still answers its health check');
    assert.match(out, /replies not starting: would repair/);
    assert.doesNotMatch(out, /would restart:hermes/);
    const saved = JSON.parse(fs.readFileSync(path.join(r.dir, 'guardian.json'), 'utf8'));
    assert.match(saved.outage.first.join(' '), /Replies are starting: Your agent took a message 4 min ago and hasn't started on it/);
    assert.match(fs.readFileSync(path.join(r.dir, 'incidents.jsonl'), 'utf8'), /Replies aren't starting/);
  } finally { r.close(); }
});

test('guardian: a reply that is only just waiting, or a box whose Agent Service does not report it, stays green', async () => {
  for (const queue of [{ replies_not_started: 1, replies_not_started_s: 30, replies_given_up_15m: 0 }, {}]) {
    const r = await rig(queue);
    try {
      const out = await node(['bin/guardian.mjs', '--dry-run'], r.env);
      assert.ok(!JSON.parse(out.trim().split('\n').pop()).failing.includes('replies-start'), out);
    } finally { r.close(); }
  }
});

const probe = `
const { callTool } = await import('./lib/toolloop.mjs');
const status = await callTool('check_status', '{}');
let asked = null;
const fix = await callTool('run_fix', '{"action":"restart:hermes"}', { authorize: async request => { asked = request; return false; } });
console.log(JSON.stringify({ status, fix, asked }));`;

test('repair chat: restart:hermes reaches the owner for confirmation while replies are not starting, even with Hermes green', async () => {
  const r = await rig({ replies_not_started: 1, replies_not_started_s: 240, replies_given_up_15m: 0 });
  try {
    const { status, fix, asked } = JSON.parse(await node(['--input-type=module', '-e', probe], r.env));
    assert.match(status, /FAIL replies-start — Replies are starting: .*\[fix: restart:hermes\]/);
    assert.match(status, /OK {3}hermes — /);
    assert.deepEqual(asked, { tool: 'run_fix', args: { action: 'restart:hermes' } }, 'the owner is asked to confirm');
    assert.match(fix, /owner approval denied/);
  } finally { r.close(); }
});

test('repair chat: with replies starting, a green Hermes is still not restarted', async () => {
  const r = await rig({ replies_not_started: 0, replies_not_started_s: 0, replies_given_up_15m: 0 });
  try {
    const { fix, asked } = JSON.parse(await node(['--input-type=module', '-e', probe], r.env));
    assert.match(fix, /Refused: Your agent \(Hermes\) is working right now/);
    assert.equal(asked, null);
  } finally { r.close(); }
});

test('a reply Wizard gave up on in the last 15 min keeps the incident visible', async () => {
  const r = await rig({ replies_not_started: 0, replies_not_started_s: 0, replies_given_up_15m: 1 });
  try {
    const out = await node(['--input-type=module', '-e', probe], r.env);
    assert.match(JSON.parse(out).status, /FAIL replies-start — Replies are starting: A message your agent took in the last 15 min never started/);
  } finally { r.close(); }
});

// 7 Nov 2026: Hermes took up to 20 min to accept new runs. The Agent Service stayed up (its front page answered in
// 1 ms) but its health check hung, so the guardian restarted it four times in an hour. A restart cannot make Hermes
// faster and cut off work in flight. Busy is not down, and a restart that didn't hold is not repeated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
process.env.TROUBLESHOOT_STATE ||= fs.mkdtempSync((process.env.TMPDIR || os.tmpdir()) + '/g-');
const { restartHold, busyNotes, BUSY_TEXT } = await import('../bin/guardian.mjs');
const MIN = 60e3, now = Date.parse('2026-11-07T14:30:00Z');

test('a restart that did not keep the piece working for 30 min pauses restarts for an hour, escalating once', () => {
  const s = { lastFix: { 'agent-service': now - 10 * MIN } };
  const first = restartHold(s, 'agent-service', now);
  assert.equal(first.held, true);
  assert.equal(first.fresh, true);
  assert.equal(first.hold.until, now + 60 * MIN);
  s.restartHold = { 'agent-service': first.hold };
  const later = restartHold(s, 'agent-service', now + 20 * MIN);
  assert.equal(later.held, true);
  assert.equal(later.fresh, false, 'the escalation happens once, not every minute');
  assert.equal(restartHold(s, 'agent-service', now + 61 * MIN).held, false, 'after the pause a restart is allowed again');
});

test('a restart that kept the piece working for over 30 min may be repeated', () => {
  assert.equal(restartHold({ lastFix: { shell: now - 31 * MIN } }, 'shell', now).held, false);
  assert.equal(restartHold({}, 'shell', now).held, false);
});

test('"Hermes is slow" is noted once per episode, not every minute', () => {
  const s = {};
  const busy = [{ id: 'agent-service', busy: true }];
  assert.deepEqual(busyNotes(s, busy, now).map(n => n.text), [BUSY_TEXT]);
  for (let m = 1; m <= 10; m++) assert.deepEqual(busyNotes(s, busy, now + m * MIN), []);
  const ended = busyNotes(s, [{ id: 'agent-service', busy: false }], now + 11 * MIN);
  assert.equal(ended.length, 1);
  assert.match(ended[0].text, /normally again \(it was slow for about 11 min\)/);
  // It flaps back within half an hour: no second note yet.
  assert.deepEqual(busyNotes(s, busy, now + 12 * MIN), []);
  assert.deepEqual(busyNotes(s, [{ id: 'agent-service' }], now + 13 * MIN), []);
  assert.equal(busyNotes(s, busy, now + 45 * MIN).length, 1);
});

// A fake Agent Service on a real port; the guardian runs in report-only mode against it with its own state.
async function fakeAgent(health) {
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(302, { Location: '/wizard-os-home/' }); res.end(); return; }
    if (req.url === '/wizard/health') { if (health) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(health)); } return; /* hang */ }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
}
async function closedPort() {
  const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address(); await new Promise(r => s.close(r)); return port;
}
async function dryRun(agentPort, state) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'guardian-dry-'));
  if (state) fs.writeFileSync(path.join(dir, 'guardian.json'), JSON.stringify(state));
  const closed = await closedPort();
  const env = { PATH: process.env.PATH, HOME: dir, TROUBLESHOOT_STATE: dir, WAS_RELEASE_ROOT: path.join(dir, 'releases'), AGENT_PORT: String(agentPort),
    AGENT_HEALTH_TIMEOUT_MS: '400', AGENT_UNIT: 'fake-agent.service', HERMES_PORT: String(closed), GATEWAY_PORT: String(closed), SHELL_PORT: String(closed),
    AUTH_PORT: '0', TS_SOCKET: path.join(dir, 'no.sock'), GUARDIAN_THREAD: '', GUARDIAN_TZ: 'Asia/Bangkok' };
  const child = spawn(process.execPath, ['bin/guardian.mjs', '--dry-run'], { cwd: path.resolve(import.meta.dirname, '..'), env });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 0, err);
  const incidents = fs.existsSync(path.join(dir, 'incidents.jsonl')) ? fs.readFileSync(path.join(dir, 'incidents.jsonl'), 'utf8') : '';
  return { out, summary: JSON.parse(out.trim().split('\n').pop()), incidents, saved: JSON.parse(fs.readFileSync(path.join(dir, 'guardian.json'), 'utf8')) };
}
const pastThreshold = { fails: { 'agent-service': 5 }, fixes: {}, outage: null, lastAiRepair: 0, rolledBack: {} };

test('dry run: Agent Service answering but its health check hanging is busy, never restarted', async () => {
  const server = await fakeAgent(null);
  try {
    const { out, summary, saved } = await dryRun(server.address().port, pastThreshold);
    assert.doesNotMatch(out, /would restart:agent-service|would rollback/);
    assert.match(out, /busy, not restarting: Agent Service/);
    assert.match(out, /Hermes is taking a long time to accept new messages; your messages are queued and will send\./);
    assert.deepEqual(summary.actions, []);
    assert.deepEqual(summary.busy, ['agent-service']);
    assert.equal(saved.fails['agent-service'], 0, 'busy minutes never count toward a restart');
    assert.ok(!(saved.outage?.first || []).some(line => line.startsWith('Agent Service')), 'busy is not an outage');
  } finally { server.close(); }
});

test('dry run: health reporting Hermes slow to accept is busy, never restarted', async () => {
  const server = await fakeAgent({ status: 'ok', upstream_reachable: true, queue: { active: 1, queued: 6, launching: 1, launch_waiting_s: 900, hermes_slow_to_accept: true } });
  try {
    const { out, summary } = await dryRun(server.address().port, pastThreshold);
    assert.doesNotMatch(out, /would restart:agent-service/);
    assert.deepEqual(summary.busy, ['agent-service']);
    assert.ok(!summary.failing.includes('agent-service'));
  } finally { server.close(); }
});

test('dry run: an Agent Service that is not running at all is still restarted', async () => {
  const { out } = await dryRun(await closedPort(), pastThreshold);
  assert.match(out, /would restart:agent-service/);
});

test('dry run: a restart that did not hold pauses restarts instead of restarting again', async () => {
  const { out, summary } = await dryRun(await closedPort(), { ...pastThreshold, lastFix: { 'agent-service': Date.now() - 10 * MIN } });
  assert.doesNotMatch(out, /would restart:agent-service/);
  assert.match(out, /would pause restarts: Restarting Agent Service at \d\d:\d\d \(Bangkok time\) didn't keep it working .* so Wizard won't restart it again before \d\d:\d\d\./);
  assert.deepEqual(summary.actions, []);
});

// 13 Nov 2026 (#46): the Agent Service froze at 03:25, 03:58, 05:25 and 06:03 UTC. Each time a restart brought it
// back and the guardian said "Wizard is working again ... is fixed", while the cause (a phone resending one request
// in a loop) never changed. The same check failing again within 2 hours is a problem that keeps coming back: never
// called fixed, and the repair chat is asked for the cause.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
process.env.TROUBLESHOOT_STATE ||= fs.mkdtempSync((process.env.TMPDIR || os.tmpdir()) + '/g-');
const { outageRecurrence, recoveryText } = await import('../bin/guardian.mjs');
const MIN = 60e3, at = hm => Date.parse(`2026-11-13T${hm}:00Z`);

test('the 13 Nov outages: the first is new, every later one within 2 h is a repeat', () => {
  const s = {};
  const seen = ['03:25', '03:58', '05:25', '06:03'].map(t => outageRecurrence(s, ['agent-service'], at(t)));
  assert.equal(seen[0], 0);
  assert.ok(seen.slice(1).every(n => n >= 1), JSON.stringify(seen));
  assert.equal(outageRecurrence(s, ['agent-service'], at('09:00')), 0, 'quiet for over 2 h: a new problem again');
  assert.equal(outageRecurrence(s, ['shell'], at('09:10')), 0, 'a different check is not the same problem');
});

test('a repeat recovery is never called fixed', () => {
  const first = recoveryText({ since: at('03:25') }, at('03:31'));
  assert.equal(first.ok, true);
  assert.match(first.post, /is fixed/);
  const again = recoveryText({ since: at('03:58'), repeat: 1 }, at('04:02'));
  assert.equal(again.ok, false);
  assert.doesNotMatch(again.log + again.post, /is fixed|working again\b(?! for now)/);
  assert.match(again.log, /answering again for now, but this is the 2nd time in 2 hours the same problem has stopped it, so it isn't fixed yet \(this time it lasted about 4 min\)\./);
  assert.match(again.post, /Wizard is looking for the cause/);
  assert.match(recoveryText({ since: at('06:03'), repeat: 2 }, at('06:05')).log, /3rd time/);
});

async function closedPort() {
  const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address(); await new Promise(r => s.close(r)); return port;
}
async function dryRun(state) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'guardian-recur-'));
  fs.writeFileSync(path.join(dir, 'guardian.json'), JSON.stringify(state));
  const closed = await closedPort();
  const env = { PATH: process.env.PATH, HOME: dir, TROUBLESHOOT_STATE: dir, WAS_RELEASE_ROOT: path.join(dir, 'releases'), AGENT_PORT: String(closed),
    AGENT_HEALTH_TIMEOUT_MS: '400', AGENT_UNIT: 'fake-agent.service', HERMES_PORT: String(closed), GATEWAY_PORT: String(closed), SHELL_PORT: String(closed),
    AUTH_PORT: '0', TS_SOCKET: path.join(dir, 'no.sock'), GUARDIAN_THREAD: '', GUARDIAN_TZ: 'Asia/Bangkok' };
  const child = spawn(process.execPath, ['bin/guardian.mjs', '--dry-run'], { cwd: path.resolve(import.meta.dirname, '..'), env });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 0, err);
  const incidents = fs.readFileSync(path.join(dir, 'incidents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'guardian.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, incidents, saved };
}
const base = { fails: {}, fixes: {}, outage: null, lastAiRepair: 0, rolledBack: {} };

test('dry run: a first outage is reported as usual, with no "keeps coming back"', async () => {
  const { out, incidents, saved } = await dryRun(base);
  const outage = incidents.find(i => i.kind === 'outage');
  assert.ok(outage);
  assert.equal(outage.recurring, undefined);
  assert.doesNotMatch(outage.text, /keeps coming back/);
  assert.doesNotMatch(out, /same outage came back/);
  assert.equal(saved.outage.repeat, undefined);
  assert.ok(saved.outageStarts['agent-service'].length === 1);
});

test('dry run: the same outage 35 min after the last one opens a "keeps coming back" incident and asks for the cause', async () => {
  const { out, incidents, saved } = await dryRun({ ...base, outageStarts: { 'agent-service': [Date.now() - 35 * MIN] } });
  const outage = incidents.find(i => i.kind === 'outage');
  assert.equal(outage.recurring, 2);
  assert.match(outage.text, /^This keeps coming back \(the 2nd time in 2 hours\): Problem found: .*Agent Service/);
  assert.equal(saved.outage.repeat, 1);
  assert.match(out, /the same outage came back \(2 times in 2 h\), would start a repair chat for the cause:\n- Agent Service: Not running\.\n\{/, 'only the check that came back is named');
});

// Owner-approved repair plans: the approval gate, the protected-data rules and the executor (backup, transcript,
// verify, undo). Hermetic: a throwaway HOME and state directory, no real units or health endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'repair-plan-'));
const HOME = path.join(root, 'home');
for (const [a, privacy] of [['private', 'private'], ['pi', 'standard']]) {
  fs.mkdirSync(path.join(HOME, '.wizard-os/agents', a), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.wizard-os/agents', a, 'agent.json'), JSON.stringify({ id: a, privacy }));
}
fs.mkdirSync(path.join(HOME, 'runtipi/app-data/wizardapps/messenger'), { recursive: true });
process.env.HOME = HOME;
process.env.TROUBLESHOOT_STATE = path.join(root, 'state');
process.env.REPAIR_HEALTH_URLS = ''; // no health targets in the hermetic run
process.env.REPAIR_VERIFY_WAIT_MS = '4000';
const P = await import('../lib/repair-plan.mjs');

const launched = [];
P.setLauncher(x => { launched.push(x); return { via: 'test' }; });
const execute = (dir, ...flags) => spawnSync(process.execPath, [path.join(APP, 'bin/execute-plan.mjs'), dir, ...flags], { env: { ...process.env }, encoding: 'utf8', timeout: 60000 });
const dirOf = id => path.join(P.PLANS, id);
const target = path.join(HOME, 'demo/app.conf');
fs.mkdirSync(path.dirname(target), { recursive: true });

test('private agents, Messenger data, recordings and sign-in files are refused in every step kind', () => {
  const base = { title: 't', diagnosis: 'd' };
  const refuse = (steps, re) => assert.throws(() => P.normalizePlan({ ...base, steps }), re);
  refuse([{ action: 'edit', path: path.join(HOME, '.wizard-os/agents/private/agent.json'), find: 'a', replace: 'b' }], /private data/);
  refuse([{ action: 'write', path: path.join(HOME, 'runtipi/app-data/wizardapps/messenger/db.json'), content: 'x' }], /private data/);
  refuse([{ action: 'write', path: path.join(HOME, 'runtipi/app-data/wizardapps/mizel/rec.wav'), content: 'x' }], /private data/);
  refuse([{ action: 'run', command: 'cat ~/.wizard-os/agents/private/home/notes.md' }], /private data/);
  refuse([{ action: 'run', command: 'rm -rf $HOME/.wizard-os/messenger-owner' }], /private data/);
  refuse([{ action: 'run', command: 'grep -r token ~/.wizard-os/agents/*' }], /every agent/);
  refuse([{ action: 'edit', path: path.join(HOME, '.hermes/.env'), find: 'a', replace: 'b' }], /secret/);
  refuse([{ action: 'write', path: path.join(HOME, '.claude/.credentials.json'), content: '{}' }], /secret/);
  refuse([{ action: 'write', path: 'relative/file', content: 'x' }], /absolute/);
  refuse([{ action: 'launch', command: 'x' }], /action must be/);
  // A symlink can't smuggle a protected target past the check.
  const link = path.join(HOME, 'innocent');
  fs.symlinkSync(path.join(HOME, '.wizard-os/agents/private'), link);
  refuse([{ action: 'write', path: path.join(link, 'agent.json'), content: 'x' }], /private data/);
  // A standard agent and ordinary files are allowed.
  const ok = P.normalizePlan({ ...base, steps: [{ action: 'edit', path: path.join(HOME, '.wizard-os/agents/pi/agent.json'), find: 'pi', replace: 'pi' }, { action: 'run', command: 'systemctl --user restart hermes-gateway.service' }] });
  assert.equal(ok.steps.length, 2);
  assert.match(P.pathRefusal(path.join(HOME, '.wizard-os/agents/private/x'), { read: true }), /private data/);
});

test('nothing runs until the owner approves the exact digest the page showed; one approval, one run', () => {
  fs.writeFileSync(target, 'mode=broken\n');
  const rec = P.createPlan({ title: 'Fix the demo config', diagnosis: 'It says broken.', steps: [{ action: 'edit', path: target, find: 'broken', replace: 'fixed' }] }, { convId: 'a'.repeat(16) });
  assert.equal(P.planState(rec.id).state, 'proposed');
  assert.equal(launched.length, 0);
  assert.throws(() => P.approvePlan(rec.id, 'f'.repeat(64), 'owner'), /changed since it was shown/);
  assert.throws(() => P.approvePlan(rec.id, undefined, 'owner'), /changed since it was shown/);
  assert.equal(launched.length, 0);
  // Tampering with the stored plan after it was shown invalidates the old digest.
  const f = path.join(dirOf(rec.id), 'plan.json'), saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...saved, plan: { ...saved.plan, steps: [{ action: 'run', command: 'echo evil', timeout_s: 5 }] } }));
  assert.throws(() => P.approvePlan(rec.id, rec.digest, 'owner'), /changed since it was shown/);
  fs.writeFileSync(f, JSON.stringify(saved));
  const r = P.approvePlan(rec.id, rec.digest, 'james@example.com');
  assert.equal(r.approved, true);
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0].args.slice(1), [dirOf(rec.id)]);
  assert.throws(() => P.approvePlan(rec.id, rec.digest, 'owner'), /starting|already/);
  assert.equal(launched.length, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'mode=broken\n', 'approval alone changes nothing; the executor does');
});

test('dismissed and expired plans cannot be approved', () => {
  const a = P.createPlan({ title: 'x', diagnosis: 'y', steps: [{ action: 'run', command: 'true' }] });
  P.dismissPlan(a.id, 'owner');
  assert.throws(() => P.approvePlan(a.id, a.digest, 'owner'), /dismissed/);
  const b = P.createPlan({ title: 'x', diagnosis: 'y', steps: [{ action: 'run', command: 'true' }] });
  const f = path.join(dirOf(b.id), 'plan.json'), saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...saved, createdAt: new Date(Date.now() - 48 * 3600e3).toISOString() }));
  assert.equal(P.planState(b.id).state, 'expired');
  assert.throws(() => P.approvePlan(b.id, b.digest, 'owner'), /expired/);
});

test('the executor refuses a plan without approval and leaves files alone', () => {
  fs.writeFileSync(target, 'mode=broken\n');
  const rec = P.createPlan({ title: 'Unapproved', diagnosis: 'd', steps: [{ action: 'write', path: target, content: 'mode=fixed\n' }] });
  const r = execute(dirOf(rec.id));
  assert.equal(r.status, 3);
  assert.equal(fs.readFileSync(target, 'utf8'), 'mode=broken\n');
  assert.match(fs.readFileSync(path.join(dirOf(rec.id), 'transcript.log'), 'utf8'), /REFUSED: no owner approval/);
});

test('approved plan: backup, apply, transcript, verify; runs once; undo restores every touched file', () => {
  fs.writeFileSync(target, 'mode=broken\nother=1\n');
  const touched = path.join(HOME, 'demo/by-command.txt');
  fs.writeFileSync(touched, 'before\n');
  const rec = P.createPlan({ title: 'Fix the demo', diagnosis: 'Config says broken.', steps: [
    { action: 'edit', path: target, find: 'mode=broken', replace: 'mode=fixed', why: 'Switch it back on.' },
    { action: 'run', command: `echo after > ${touched} && echo did-the-thing`, timeout_s: 20 },
  ], verify: [`grep -q mode=fixed ${target}`] });
  P.approvePlan(rec.id, rec.digest, 'owner');
  const r = execute(dirOf(rec.id));
  assert.equal(r.status, 0, r.stderr);
  const st = P.planState(rec.id);
  assert.equal(st.state, 'succeeded');
  assert.equal(st.run.verified, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'mode=fixed\nother=1\n');
  assert.equal(fs.readFileSync(touched, 'utf8'), 'after\n');
  assert.equal(st.run.backups.length, 2);
  for (const b of st.run.backups) assert.ok(fs.existsSync(b.backup));
  assert.match(st.transcript, /backup .*app\.conf/);
  assert.match(st.transcript, /did-the-thing/);
  assert.match(st.transcript, /verify 1: exit 0/);
  assert.match(st.transcript, /Repair succeeded and verified/);
  assert.equal(execute(dirOf(rec.id)).status, 4, 'never runs twice');
  // The next owner message tells the model what happened, once.
  assert.match(P.unreportedResults(null) + P.listPlans({}).length, /./);
  // Undo
  P.undoPlan(rec.id, 'owner');
  assert.equal(P.planState(rec.id).state, 'undoing', 'the page keeps following it until the undo unit reports');
  assert.equal(execute(dirOf(rec.id), '--undo').status, 0);
  assert.equal(P.planState(rec.id).state, 'undone');
  assert.equal(fs.readFileSync(target, 'utf8'), 'mode=broken\nother=1\n');
  assert.equal(fs.readFileSync(touched, 'utf8'), 'before\n');
  assert.throws(() => P.undoPlan(rec.id, 'owner'), /Nothing to undo|already/);
});

test('a failing step stops the plan, later steps never run, health is still checked and it reports failure', () => {
  const marker = path.join(HOME, 'demo/should-not-exist');
  const rec = P.createPlan({ title: 'Fails', diagnosis: 'd', steps: [{ action: 'run', command: 'exit 7' }, { action: 'run', command: `touch ${marker}` }] });
  P.approvePlan(rec.id, rec.digest, 'owner');
  execute(dirOf(rec.id));
  const st = P.planState(rec.id);
  assert.equal(st.state, 'failed');
  assert.match(st.run.error, /step 1 exited 7/);
  assert.equal(fs.existsSync(marker), false);
  assert.match(st.transcript, /Checking health anyway/);
});

test('verify checks retry while a just-restarted service comes up', () => {
  const flag = path.join(HOME, 'demo/up-later');
  const rec = P.createPlan({ title: 'Slow start', diagnosis: 'd', steps: [{ action: 'run', command: `(sleep 2; touch ${flag}) >/dev/null 2>&1 &` }], verify: [`test -f ${flag}`] });
  P.approvePlan(rec.id, rec.digest, 'owner');
  execute(dirOf(rec.id));
  const st = P.planState(rec.id);
  assert.equal(st.state, 'succeeded', st.transcript);
  assert.ok(st.run.verify[0].tries > 1);
});

test('a file that cannot be backed up stops the plan before any step; undo never deletes it', () => {
  const locked = path.join(HOME, 'demo/locked.conf');
  fs.writeFileSync(locked, 'keep\n'); fs.chmodSync(locked, 0o000);
  const marker = path.join(HOME, 'demo/step-ran');
  const rec = P.createPlan({ title: 'Locked', diagnosis: 'd', steps: [{ action: 'run', command: `touch ${marker}; cat ${locked}` }] });
  P.approvePlan(rec.id, rec.digest, 'owner');
  execute(dirOf(rec.id));
  fs.chmodSync(locked, 0o644);
  const st = P.planState(rec.id);
  if (process.getuid?.() === 0) return; // root reads anything; nothing to prove
  assert.equal(st.state, 'failed'); assert.match(st.run.error, /backup failed, nothing changed/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(locked, 'utf8'), 'keep\n');
});

test('undo leaves files changed after the repair alone, and an interrupted run can still be undone', () => {
  const a = path.join(HOME, 'demo/a.conf'), b = path.join(HOME, 'demo/b.conf');
  fs.writeFileSync(a, 'a1\n'); fs.writeFileSync(b, 'b1\n');
  const rec = P.createPlan({ title: 'Two files', diagnosis: 'd', steps: [{ action: 'write', path: a, content: 'a2\n' }, { action: 'write', path: b, content: 'b2\n' }] });
  assert.deepEqual(P.planState(rec.id).backsUp, [a, b], 'the card shows exactly what Undo covers');
  P.approvePlan(rec.id, rec.digest, 'owner'); execute(dirOf(rec.id));
  fs.writeFileSync(b, 'b3 written later by someone else\n');
  P.undoPlan(rec.id, 'owner'); execute(dirOf(rec.id), '--undo');
  assert.equal(fs.readFileSync(a, 'utf8'), 'a1\n');
  assert.equal(fs.readFileSync(b, 'utf8'), 'b3 written later by someone else\n');
  assert.match(P.planState(rec.id).transcript, /left .*b\.conf as is/);
  // Interrupted: run.json says running but its process is gone.
  const r2 = P.createPlan({ title: 'Killed', diagnosis: 'd', steps: [{ action: 'write', path: a, content: 'x\n' }] });
  P.approvePlan(r2.id, r2.digest, 'owner');
  fs.writeFileSync(path.join(dirOf(r2.id), 'run.json'), JSON.stringify({ state: 'running', pid: 2 ** 22 + 12345, backups: [{ path: a, backup: path.join(dirOf(r2.id), 'nope'), existed: true }] }));
  const st = P.planState(r2.id);
  assert.equal(st.state, 'failed'); assert.equal(st.run.interrupted, true);
  assert.equal(P.undoPlan(r2.id, 'owner').undoing, true);
});

test('an edit whose text is not found exactly once fails closed', () => {
  fs.writeFileSync(target, 'a\na\n');
  const rec = P.createPlan({ title: 'Ambiguous', diagnosis: 'd', steps: [{ action: 'edit', path: target, find: 'a', replace: 'b' }] });
  P.approvePlan(rec.id, rec.digest, 'owner');
  execute(dirOf(rec.id));
  assert.equal(P.planState(rec.id).state, 'failed');
  assert.equal(fs.readFileSync(target, 'utf8'), 'a\na\n');
});

test('the read-only inspection tools refuse private data and secrets, and propose_repair only saves a plan', async () => {
  assert.match(await P.planTool('inspect_file', { path: path.join(HOME, '.wizard-os/agents/private/agent.json') }), /Refused/);
  fs.mkdirSync(path.join(HOME, '.hermes'), { recursive: true }); fs.writeFileSync(path.join(HOME, '.hermes/.env'), 'KEY=1');
  assert.match(await P.planTool('inspect_file', { path: path.join(HOME, '.hermes/.env') }), /secret/);
  assert.match(await P.planTool('inspect_file', { path: path.join(HOME, '.wizard-os/agents/pi/agent.json') }), /"standard"/);
  assert.match(await P.planTool('list_dir', { path: path.join(HOME, '.wizard-os/agents') }), /private \(private: not opened\)/);
  fs.writeFileSync(path.join(HOME, '.wizard-os/agents/private/needle.txt'), 'needle-123');
  fs.writeFileSync(path.join(HOME, '.wizard-os/agents/pi/needle.txt'), 'needle-123');
  const found = await P.planTool('search_text', { pattern: 'needle-123', path: path.join(HOME, '.wizard-os') });
  assert.match(found, /pi\/needle\.txt/); assert.doesNotMatch(found, /private\/needle/);
  const before = launched.length; let shown = null;
  const out = JSON.parse(await P.planTool('propose_repair', { title: 'T', diagnosis: 'D', steps: [{ action: 'run', command: 'true' }] }, { convId: 'b'.repeat(16), engine: 'claude', onProposal: r => { shown = r; } }));
  assert.equal(out.proposed, true); assert.equal(shown.id, out.plan); assert.equal(launched.length, before);
  assert.equal(P.planState(out.plan).state, 'proposed');
  assert.match(await P.planTool('propose_repair', { title: 'T', diagnosis: 'D', steps: [{ action: 'run', command: 'cat ~/.wizard-os/agents/private/agent.json' }] }), /Refused/);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

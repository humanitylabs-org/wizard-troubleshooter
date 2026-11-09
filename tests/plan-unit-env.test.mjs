// 9 Nov 2026: the owner approved a repair plan and it failed at once with "REFUSED: repair plans are switched off",
// although the box's repair policy said "plans": true. The plan runs in a transient systemd unit, which inherits
// nothing from this service, and REPAIR_POLICY_FILE was not among the settings passed to it. This drives the
// PRODUCTION launcher (no setLauncher hook) through a fake `systemd-run` that, like the real one, starts the
// command with only its --setenv values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const APP = path.resolve(import.meta.dirname, '..');
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'plan-unit-env-'));
const HOME = path.join(root, 'home'), STATE = path.join(root, 'state'), BIN = path.join(root, 'bin');
for (const d of [HOME, STATE, BIN]) fs.mkdirSync(d, { recursive: true });
const POLICY = path.join(root, 'policy.json');
fs.writeFileSync(POLICY, JSON.stringify({ files: [], commands: {}, plans: true }));
const ARGS = path.join(root, 'systemd-run.args');
fs.writeFileSync(path.join(BIN, 'systemd-run'), `#!/bin/bash
printf '%s\\n' "$@" > ${JSON.stringify(ARGS)}
envs=(); cwd=/
while [[ $# -gt 0 ]]; do case "$1" in --setenv=*) envs+=("\${1#--setenv=}");; --working-directory=*) cwd="\${1#--working-directory=}";; --*) ;; *) break;; esac; shift; done
cd "$cwd" && env -i "\${envs[@]}" "$@" </dev/null >/dev/null 2>&1 &
exit 0
`, { mode: 0o755 });

const env = { PATH: `${BIN}:${process.env.PATH}`, HOME, TROUBLESHOOT_STATE: STATE, REPAIR_POLICY_FILE: POLICY, REPAIR_HEALTH_URLS: '',
  HERMES_UNIT: '', AGENT_UNIT: '', REPAIR_BRIDGE_TOKEN: 'tk-never-in-a-unit-0123456789', PARENT_ONLY: 'yes' };
const approve = `
import fs from 'node:fs';
const P = await import('./lib/repair-plan.mjs');
const target = process.env.HOME + '/demo.conf';
fs.writeFileSync(target, 'mode=broken\\n');
const rec = P.createPlan({ title: 'Fix the demo config', diagnosis: 'It says broken.', steps: [{ action: 'edit', path: target, find: 'broken', replace: 'fixed' }] });
console.log(JSON.stringify({ id: rec.id, dir: P.PLANS + '/' + rec.id, ...P.approvePlan(rec.id, rec.digest, 'owner') }));`;

test('an approved plan launched through systemd-run sees the repair policy and runs (not "switched off")', async () => {
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', approve], { cwd: APP, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(p.status, 0, p.stderr);
  const r = JSON.parse(p.stdout.trim().split('\n').pop());
  assert.equal(r.via, 'systemd-run', 'the production launcher path, not a test hook');
  const runFile = path.join(r.dir, 'run.json');
  let run = null;
  for (let i = 0; i < 150 && !['succeeded', 'failed'].includes(run?.state); i++) { await new Promise(res => setTimeout(res, 200)); try { run = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch {} }
  const transcript = fs.readFileSync(path.join(r.dir, 'transcript.log'), 'utf8');
  assert.equal(run?.state, 'succeeded', transcript);
  assert.doesNotMatch(transcript, /REFUSED/);
  assert.equal(fs.readFileSync(path.join(HOME, 'demo.conf'), 'utf8'), 'mode=fixed\n');
  const args = fs.readFileSync(ARGS, 'utf8').split('\n');
  assert.ok(args.includes(`--setenv=REPAIR_POLICY_FILE=${POLICY}`), args.join(' '));
  assert.ok(args.includes(`--setenv=TROUBLESHOOT_STATE=${STATE}`));
  assert.ok(args.includes('--setenv=REPAIR_HEALTH_URLS='), 'empty settings are passed as empty, not dropped');
  assert.ok(!args.some(a => /REPAIR_BRIDGE_TOKEN|tk-never|PARENT_ONLY/.test(a)), 'tokens and unrelated settings never go into the unit');
});

test('an executor started without REPAIR_POLICY_FILE reads the box default policy, so it agrees with the page', () => {
  const dir = fs.readdirSync(path.join(STATE, 'repair-plans'))[0];
  const dflt = path.join(HOME, '.config/wizard-troubleshooter/repair-policy.json');
  fs.mkdirSync(path.dirname(dflt), { recursive: true });
  fs.writeFileSync(dflt, JSON.stringify({ files: [], commands: {}, plans: false }));
  try {
    const p = spawnSync(process.execPath, ['bin/execute-plan.mjs', path.join(STATE, 'repair-plans', dir)], { cwd: APP, env: { PATH: process.env.PATH, HOME, TROUBLESHOOT_STATE: STATE }, encoding: 'utf8' });
    assert.equal(p.status, 3);
    assert.match(fs.readFileSync(path.join(STATE, 'repair-plans', dir, 'transcript.log'), 'utf8'), /REFUSED: repair plans are switched off in this box's repair policy/);
  } finally { fs.rmSync(dflt); }
});

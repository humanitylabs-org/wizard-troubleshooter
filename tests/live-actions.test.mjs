import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('all live manual restart actions and connection warnings remain available', () => {
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'live-actions-'));
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', "import {ACTIONS} from './lib/checks.mjs';console.log(JSON.stringify(ACTIONS))"], { cwd: path.resolve(import.meta.dirname, '..'), env: { PATH: process.env.PATH, HOME: state, TROUBLESHOOT_STATE: state }, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr); const a = JSON.parse(p.stdout);
  assert.equal(a['restart:tailscale'].label, 'Restart private network'); assert.equal(a['restart:tailscale'].warn, 'Your connection drops for a few seconds.');
  assert.equal(a['restart:gateway'].label, 'Restart secure gateway'); assert.equal(a['restart:gateway'].warn, 'This page reloads after a few seconds.');
  assert.equal(a['restart:signin'].label, 'Restart sign-in check');
  assert.equal(a['restart:shell'].label, 'Restart Wizard app screens');
  assert.equal(a['restart:agent-service'].label, 'Restart Agent Service');
  assert.ok(a['restart:hermes']);
});

test('an app-managed Agent Service is recreated through App Manager, never raw Docker', () => {
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'agent-lifecycle-'));
  const wam = path.join(state, 'wam');
  const called = path.join(state, 'called.json');
  fs.writeFileSync(wam, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(called)}, JSON.stringify(process.argv.slice(2)))\n`);
  fs.chmodSync(wam, 0o755);
  const script = "import {ACTIONS,doAction} from './lib/checks.mjs';const a=ACTIONS['restart:agent-service'];const r=await doAction('restart:agent-service');console.log(JSON.stringify({a,r}))";
  const env = { PATH: process.env.PATH, HOME: state, TROUBLESHOOT_STATE: state, AGENT_UNIT: '', AGENT_CONTAINER: 'wizard-agent-service_wizardapps-wizard-agent-service-1', WAM_BIN: wam, DOCKER_BIN: '/usr/bin/docker' };
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const { a, r } = JSON.parse(p.stdout);
  assert.deepEqual(a.cmd, [wam, ['app', 'restart', 'wizard-agent-service']]);
  assert.ok(a.timeout >= 300000, 'App Manager restart waits up to 300 s, so the action must outlast it');
  assert.deepEqual(JSON.parse(fs.readFileSync(called, 'utf8')), ['app', 'restart', 'wizard-agent-service']);
  assert.equal(r.ok, true);
});

test('an app-managed Agent Service has no misleading raw-Docker fix when App Manager is unavailable', () => {
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'agent-lifecycle-missing-'));
  const script = "import {ACTIONS} from './lib/checks.mjs';console.log(JSON.stringify(ACTIONS['restart:agent-service'] || null))";
  const env = { PATH: process.env.PATH, HOME: state, TROUBLESHOOT_STATE: state, AGENT_UNIT: '', AGENT_CONTAINER: 'wizard-agent-service_wizardapps-wizard-agent-service-1', WAM_BIN: path.join(state, 'missing-wam'), DOCKER_BIN: '/usr/bin/docker' };
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout), null);
});

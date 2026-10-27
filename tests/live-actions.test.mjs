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

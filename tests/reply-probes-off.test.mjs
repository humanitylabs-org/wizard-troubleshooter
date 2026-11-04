// Synthetic reply probes spend tokens around the clock and can declare Wizard down on their own,
// so they stay off unless the owner sets TROUBLESHOOTER_REPLY_PROBES=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const ids = env => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const { CHECKS } = await import('./lib/checks.mjs'); console.log(JSON.stringify(CHECKS.map(c => c.id)));"], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
};

test('reply probes are off by default', () => {
  const list = ids({ TROUBLESHOOTER_REPLY_PROBES: '' });
  assert.ok(!list.includes('agent-reply'));
  assert.ok(!list.some(id => id.startsWith('reply-')));
  assert.ok(list.includes('hermes'), 'service checks remain');
});

test('the owner can turn them back on', () => {
  const list = ids({ TROUBLESHOOTER_REPLY_PROBES: '1' });
  assert.ok(list.includes('agent-reply'));
  assert.ok(list.includes('reply-claude'));
});

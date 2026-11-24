// #17 switched the synthetic reply probes off because they cost tokens all day. #62 (24 Nov 2026): with them off, no
// chat got a reply for six hours while every check was green. Now the main agent's reply check is on by default but
// rate-limited (one tiny reply an hour while it works), the probes to each repair engine stay opt-in, and
// TROUBLESHOOTER_REPLY_PROBES=0 turns the reply check off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const load = env => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const { CHECKS, CONFIG } = await import('./lib/checks.mjs'); console.log(JSON.stringify({ ids: CHECKS.map(c => c.id), okMs: CONFIG.agentReplyOkMs, failMs: CONFIG.agentReplyFailMs }));"], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
};

test('by default the main agent reply check runs, at most once an hour; repair engine probes stay off', () => {
  const { ids, okMs, failMs } = load({ TROUBLESHOOTER_REPLY_PROBES: '', REPLY_CHECK_EVERY_MIN: '' });
  assert.ok(ids.includes('agent-reply'));
  assert.ok(ids.includes('agent-signin'));
  assert.ok(!ids.some(id => id.startsWith('reply-')));
  assert.ok(ids.includes('hermes'), 'service checks remain');
  assert.equal(okMs, 3600e3); assert.equal(failMs, 300e3);
});

test('the owner can turn the reply check off, or back to every probe', () => {
  assert.ok(!load({ TROUBLESHOOTER_REPLY_PROBES: '0' }).ids.includes('agent-reply'));
  const all = load({ TROUBLESHOOTER_REPLY_PROBES: '1' });
  assert.ok(all.ids.includes('agent-reply'));
  assert.ok(all.ids.includes('reply-claude'));
  assert.equal(all.okMs, 600e3);
});

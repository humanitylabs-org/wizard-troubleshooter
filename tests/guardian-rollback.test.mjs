// The guardian must never undo an update for a problem that started before that update.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.TROUBLESHOOT_STATE ||= fs.mkdtempSync((process.env.TMPDIR || '/tmp') + '/g-');
const { updateCausedIt } = await import('../bin/guardian.mjs');
const H = 3600e3, now = Date.parse('2026-10-31T08:34:00Z');

test('31 Oct regression: Agent Service slow before the fix was deployed → no rollback of the fix', () => {
  const release = { target: 'was-a639e67', changedAt: Date.parse('2026-10-31T08:15:32Z') };
  const s = { failTimes: { 'agent-service': [Date.parse('2026-10-31T07:39:00Z'), Date.parse('2026-10-31T08:01:00Z'), Date.parse('2026-10-31T08:33:00Z')] } };
  assert.equal(updateCausedIt(s, 'agent-service', release, now), false);
});

test('healthy before a fresh update, failing after → rollback allowed', () => {
  const release = { target: 'was-new', changedAt: now - 20 * 60e3 };
  assert.equal(updateCausedIt({ failTimes: { 'agent-service': [now - 60e3] } }, 'agent-service', release, now), true);
});

test('old update, a version we rolled back to, or one we already undid → no rollback', () => {
  assert.equal(updateCausedIt({}, 'agent-service', { target: 'x', changedAt: now - 3 * H }, now), false);
  assert.equal(updateCausedIt({ rolledBackTo: { 'agent-service': 'prev' } }, 'agent-service', { target: 'prev', changedAt: now - 60e3 }, now), false);
  assert.equal(updateCausedIt({ rolledBack: { 'agent-service': 'bad' } }, 'agent-service', { target: 'bad', changedAt: now - 60e3 }, now), false);
});

test('failures long before the lookback window do not block a rollback', () => {
  const release = { target: 'was-new', changedAt: now - 10 * 60e3 };
  assert.equal(updateCausedIt({ failTimes: { 'agent-service': [now - 9 * H] } }, 'agent-service', release, now), true);
});

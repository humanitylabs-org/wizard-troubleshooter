// 26 Nov 2026: a long app build kept Hermes too busy to answer its health check, and the guardian restarted it,
// killing the build. While the Agent Service reports replies in progress, a slow Hermes is busy, not down.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';

process.env.TROUBLESHOOT_STATE ||= fs.mkdtempSync((process.env.TMPDIR || os.tmpdir()) + '/hb-');
let queue = { active: 1, launching: 0 };
const agent = http.createServer((req, res) => {
  if (req.url === '/wizard/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', upstream_reachable: false, queue })); return; }
  res.writeHead(200); res.end('ok');
});
await new Promise(r => agent.listen(0, '127.0.0.1', r));
process.env.AGENT_PORT = String(agent.address().port);
process.env.HERMES_PORT = '0';   // the container setup: Hermes is seen through the Agent Service
const checks = await import('../lib/checks.mjs');
test.after(() => agent.close());

const hermes = () => (checks.CHECKS || checks.default || []).find?.(c => c.id === 'hermes');

test('the Agent Service count of replies in progress is read from its health', async () => {
  queue = { active: 2, launching: 1 };
  assert.equal(await checks.hermesWorking(), 3);
  queue = { active: 0 };
  assert.equal(await checks.hermesWorking(), 0);
});

test('Hermes not reaching the Agent Service while it works on a reply is busy, never a restart', async (t) => {
  const h = hermes();
  if (!h) return t.skip('checks list not exported');
  queue = { active: 1 };
  const r = await h.probe();
  assert.equal(r.ok, false);
  assert.equal(r.busy, true);
  assert.match(r.detail, /works on a reply/);
  queue = { active: 0 };
  const idle = await h.probe();
  assert.equal(idle.busy, undefined, 'with nothing in progress it is a real failure the guardian may fix');
});

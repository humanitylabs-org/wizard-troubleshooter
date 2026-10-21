import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function isolated() {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-isolated-'));
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TROUBLESHOOT_STATE: state, TROUBLESHOOT_CONTAINER: '1', TROUBLESHOOT_DEV_NO_AUTH: '1' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/troubleshoot`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/ping`); return { child, base, state }; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  child.kill(); throw new Error('app did not start');
}

test('process health is explicitly not recovery readiness', async () => {
  const { child, base } = await isolated();
  try {
    const r = await fetch(`${base}/api/ping`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ready, false);
    assert.equal((await fetch(`${base}/api/readiness`)).status, 503);
  } finally { child.kill(); }
});

test('isolated app cannot run host actions/chat/guardian even with dev auth bypass', async () => {
  const { child, base, state } = await isolated();
  try {
    for (const endpoint of ['repair', 'guardian-repair', 'action', 'repair/stop']) {
      const r = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wizard-Troubleshoot': '1', 'X-Guardian-Token': 'forged' }, body: JSON.stringify({ message: 'never execute', action: 'hermes' }) });
      assert.equal(r.status, 503, endpoint);
      assert.equal((await r.json()).reason, 'host-component-not-provisioned');
    }
    assert.equal((await fetch(`${base}/api/status`)).status, 503, 'no misleading container-local host probes');
    assert.equal(fs.existsSync(path.join(state, 'guardian.token')), false);
  } finally { child.kill(); }
});

test('MCP exposes only read-only readiness, not repair commands', async () => {
  const { child, base } = await isolated();
  const rpc = async (method, params) => (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  try {
    const tools = await rpc('tools/list');
    assert.deepEqual(tools.result.tools.map(t => t.name), ['recovery_readiness']);
    const status = await rpc('tools/call', { name: 'recovery_readiness' });
    assert.equal(JSON.parse(status.result.content[0].text).ready, false);
    assert.equal((await rpc('tools/call', { name: 'repair' })).error.code, -32602);
  } finally { child.kill(); }
});

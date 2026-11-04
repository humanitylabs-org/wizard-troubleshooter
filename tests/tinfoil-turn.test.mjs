import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// James, 27 Oct: Troubleshooter's Tinfoil reply probe sent tools: [] with tool_choice and the app answered 400,
// so a working Tinfoil read as broken. Requests without tools must omit both fields.
test('tinfoil turns omit tools and tool_choice when there are no tools', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const j = JSON.parse(b); bodies.push(j);
    if (j.tools && !j.tools.length) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"Invalid request"}'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinfoil-turn-'));
  const tok = path.join(dir, 'token.json'); fs.writeFileSync(tok, JSON.stringify({ token: 'x'.repeat(32) }));
  process.env.TINFOIL_URL = `http://127.0.0.1:${server.address().port}`; process.env.TINFOIL_TOKEN_FILE = tok;
  try {
    const { tinfoilTurn } = await import('../lib/providers.mjs?' + Date.now());
    const r = await tinfoilTurn({ instructions: 'Reply OK', messages: [{ role: 'user', content: 'OK?' }], tools: [], model: 'm' });
    assert.equal(r.text, 'OK'); assert.equal('tools' in bodies[0], false); assert.equal('tool_choice' in bodies[0], false);
    await tinfoilTurn({ instructions: 'x', messages: [], tools: [{ name: 'a', description: 'b', parameters: { type: 'object' } }], model: 'm' });
    assert.equal(bodies[1].tools.length, 1); assert.equal(bodies[1].tool_choice, 'auto');
  } finally { server.close(); }
});

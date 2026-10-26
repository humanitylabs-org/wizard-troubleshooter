// Thin stdio MCP transport. All schemas/execution live in the HTTP parent, not here.
import readline from 'node:readline';
const url = process.env.REPAIR_BRIDGE_URL, token = process.env.REPAIR_BRIDGE_TOKEN;
const send = o => process.stdout.write(JSON.stringify(o) + '\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  let q;
  try { q = JSON.parse(line); } catch { continue; }
  if (q.id === undefined) continue;
  try {
    let result;
    if (q.method === 'initialize') result = { protocolVersion: q.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'wizard-repair', version: '1.0.0' } };
    else if (q.method === 'ping') result = {};
    else if (q.method === 'tools/list' || q.method === 'tools/call') {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: q.method, params: q.params || {} }), signal: AbortSignal.timeout(310000) });
      if (!r.ok) throw new Error('Repair bridge refused request');
      result = await r.json();
    } else throw new Error('Unsupported method');
    send({ jsonrpc: '2.0', id: q.id, result });
  } catch (e) { send({ jsonrpc: '2.0', id: q.id, error: { code: -32603, message: e.message } }); }
}

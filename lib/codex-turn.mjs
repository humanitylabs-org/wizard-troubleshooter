// Legacy boxes hold the ChatGPT app's sign-in in Codex rather than the agent store.
// Codex only proposes a JSON turn. Shell, exec, MCP and web tools are disabled; shared repair tools retain approval.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { providerFailure } from './reply-health.mjs';
export function codexTurn({ bin, stateDir, instructions, input, tools = [], model, signal, timeout = 45000 }) {
  return new Promise((resolve, reject) => {
    const schemaFile = path.join(stateDir, 'codex-turn-schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify({ type: 'object', properties: { text: { type: 'string' }, calls: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, args: { type: 'string' } }, required: ['id', 'name', 'args'], additionalProperties: false } } }, required: ['text', 'calls'], additionalProperties: false }), { mode: 0o600 });
    const prompt = `${instructions}\nYou cannot run commands or read files yourself. Return JSON {text,calls}. Use only the listed shared tools by proposing calls; their executor obtains owner approval. For a reply probe return {"text":"OK","calls":[]}.\nShared tools: ${JSON.stringify(tools)}\nMessages: ${JSON.stringify(input)}`;
    const env = { ...process.env }; delete env.OPENAI_API_KEY;
    const child = spawn(bin, ['exec', ...(model ? ['--model', model] : []), '--json', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false', '-c', 'features.unified_exec=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false', '-c', 'features.code_mode_host=false', '-c', 'features.multi_agent=false', '-c', 'features.browser_use=false', '-c', 'features.computer_use=false', '-c', 'features.image_generation=false', '-c', 'features.view_image=false', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}', '--output-schema', schemaFile, '-C', stateDir, prompt], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', text = '', error = '', finished = false;
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { error = 'ChatGPT reply timed out'; stop(); }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const handle = line => {
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.type === 'item.completed' && j.item?.type === 'agent_message') text = j.item.text;
      if (j.type === 'turn.failed' || j.type === 'error') error = j.error?.message || j.message || 'ChatGPT failed';
    };
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', () => {}); // CLI diagnostics must never expose credentials to the page
    const fail = e => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(e); };
    child.on('error', () => fail(new Error('ChatGPT program could not start')));
    child.on('close', code => {
      if (finished) return;
      clearTimeout(timer); signal?.removeEventListener('abort', stop); if (buf.trim()) handle(buf);
      if (code || error || !text) return fail(Object.assign(new Error(error || 'ChatGPT did not reply'), providerFailure(error) || {}));
      let r; try { r = JSON.parse(text); } catch { return fail(new Error('ChatGPT did not return a repair turn')); }
      if (typeof r.text !== 'string' || !Array.isArray(r.calls)) return fail(new Error('ChatGPT sent an invalid repair turn'));
      finished = true;
      const calls = r.calls.map(c => ({ ...c, args: c.args || '{}' }));
      resolve({ text: r.text, calls, replay: [...(r.text ? [{ role: 'assistant', content: [{ type: 'output_text', text: r.text }] }] : []), ...calls.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.args }))] });
    });
  });
}

// The real main-agent path, independent of Hermes/Agent Service being healthy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedProbe, replyResult } from './reply-health.mjs';
const PROMPT = 'Reply with just OK. Do not use tools.';
export function envValue(file, name) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'm'));
    return (m?.[1] || '').trim().replace(/^(["'])(.*)\1$/, '$2');
  } catch { return ''; }
}
export async function agentReply(config, run, options = {}) {
  return cachedProbe(config.stateDir, 'agent', async () => {
    const payload = { model: 'hermes-agent', messages: [{ role: 'user', content: PROMPT }], stream: false, max_tokens: 8 };
    // Fresh boxes keep Hermes inside the main hermes-agent app without publishing a host port. Execute the
    // same loopback HTTP request there; its key remains inside the container and never enters argv/stdout.
    if (!config.hermesPort) {
      if (!config.hermesContainer) return { ok: false, state: 'unavailable', detail: 'The main agent reply check needs its Hermes container configured.' };
      const script = `import os,json,urllib.request,pathlib,re
key=os.environ.get('API_SERVER_KEY','')
if not key:
 p=pathlib.Path(os.environ.get('HERMES_HOME') or '/opt/data')/'.env'
 if p.exists():
  m=re.search(r'^(?:export\\s+)?API_SERVER_KEY\\s*=\\s*(.*)$',p.read_text(),re.M)
  if m: key=m[1].strip().strip(chr(34)+chr(39))
try:
 req=urllib.request.Request('http://127.0.0.1:8642/v1/chat/completions',data=${JSON.stringify(JSON.stringify(payload))}.encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+key})
 with urllib.request.urlopen(req,timeout=25) as r: j=json.load(r)
 print(json.dumps({'text':j.get('choices',[{}])[0].get('message',{}).get('content','')}))
except Exception:
 print(json.dumps({'unavailable':True}))`;
      const r = await run(config.docker, ['exec', config.hermesContainer, '/opt/hermes/.venv/bin/python', '-c', script], { timeout: 30000 });
      let j; try { j = JSON.parse(r.out); } catch {}
      return j && !j.unavailable ? replyResult(j.text) : { ok: false, state: 'unavailable', detail: 'The main agent did not answer the reply check.' };
    }
    const file = process.env.HERMES_ENV_FILE || path.join(process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'), '.env');
    const key = process.env.API_SERVER_KEY || envValue(file, 'API_SERVER_KEY');
    try {
      const r = await fetch(`http://127.0.0.1:${config.hermesPort}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
      if (!r.ok) return { ok: false, state: 'unavailable', detail: `The main agent reply check could not connect (HTTP ${r.status}).` };
      const j = await r.json();
      return replyResult(j.choices?.[0]?.message?.content || j.error?.message);
    } catch { return { ok: false, state: 'unavailable', detail: 'The main agent did not answer the reply check.' }; }
  }, options);
}

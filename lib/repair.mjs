// Repair conversations: the owner talks directly to their own Claude or ChatGPT subscription through the
// Claude Code / Codex CLIs on this server. No Hermes, no Agent Service, no Wizard shell in the path.
// Runs are detached from the browser: the page polls, so a dropped connection never kills a repair.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CONFIG } from './checks.mjs';

const HOME = os.homedir();
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PROMPT = () => fs.readFileSync(path.join(APP, 'REPAIR_PROMPT.md'), 'utf8');
const CONV_DIR = path.join(CONFIG.stateDir, 'conversations');
const WORK = path.join(CONFIG.stateDir, 'work');
fs.mkdirSync(CONV_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
const BIN = { claude: process.env.CLAUDE_BIN || path.join(HOME, '.local/bin/claude'), chatgpt: process.env.CODEX_BIN || path.join(HOME, '.local/bin/codex') };
const RUN_LIMIT_MS = +(process.env.REPAIR_RUN_LIMIT_MS || 20 * 60e3);
const ENV = { ...process.env, PATH: `${path.join(HOME, '.local/bin')}:${process.env.PATH || '/usr/bin:/bin'}` };
delete ENV.ANTHROPIC_API_KEY; // always the owner's subscription login, never a stray API key
delete ENV.OPENAI_API_KEY;

let active = null; // { convId, child, engine }

const file = id => path.join(CONV_DIR, `${id}.json`);
const validId = id => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id);
export function loadConv(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
}
function saveConv(c) {
  const tmp = file(c.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
  fs.renameSync(tmp, file(c.id));
}
export function listConvs(limit = 10) {
  return fs.readdirSync(CONV_DIR).filter(f => f.endsWith('.json')).map(f => loadConv(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
    .map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, running: c.running, origin: c.origin }));
}
export const busy = () => active && { convId: active.convId, engine: active.engine };

function push(c, ev) {
  ev.seq = (c.events.at(-1)?.seq || 0) + 1;
  ev.at = new Date().toISOString();
  c.events.push(ev);
  c.updatedAt = ev.at;
  saveConv(c);
}

function toolSummary(name, input = {}) {
  const s = input.command || input.description || input.file_path || input.pattern || input.url || '';
  return `${name}${s ? ': ' + String(s).replace(/\s+/g, ' ').slice(0, 160) : ''}`;
}

function history(c) {
  // When this engine hasn't seen the conversation yet (first turn, or the owner switched engines), give it the transcript.
  const prior = c.events.filter(e => e.type === 'text').slice(0, -1).slice(-20);
  return prior.length ? `Conversation so far:\n${prior.map(e => `${e.role === 'owner' ? 'Owner' : (e.engine === 'chatgpt' ? 'ChatGPT' : 'Claude')}: ${e.text.slice(0, 1500)}`).join('\n')}\n\n---\nOwner's new message:\n` : '';
}

function spawnEngine(engine, c, message) {
  const prompt = PROMPT();
  if (engine === 'claude') {
    const args = ['-p', c.claudeSession ? message : history(c) + message, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--append-system-prompt', prompt];
    if (c.claudeSession) args.push('--resume', c.claudeSession);
    return spawn(BIN.claude, args, { cwd: WORK, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const text = c.codexThread ? message : `${prompt}\n\n---\n${history(c) || "Owner's message:\n"}${message}`;
  const flags = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  const args = c.codexThread ? ['exec', 'resume', c.codexThread, ...flags, text] : ['exec', ...flags, '-C', WORK, text];
  return spawn(BIN.chatgpt, args, { cwd: WORK, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function runOnce(engine, c, message) {
  return new Promise(resolve => {
    let child;
    try { child = spawnEngine(engine, c, message); } catch (e) { return resolve({ ok: false, error: e.message, said: false }); }
    active = { convId: c.id, child, engine };
    let said = false, buf = '', errTail = '', resultError = '';
    const limit = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} push(c, { type: 'note', text: 'Stopped after 20 minutes.' }); }, RUN_LIMIT_MS);
    const handle = line => {
      let j; try { j = JSON.parse(line); } catch { return; }
      if (engine === 'claude') {
        if (j.type === 'system' && j.subtype === 'init' && j.session_id) c.claudeSession = j.session_id;
        if (j.type === 'assistant') for (const b of j.message?.content || []) {
          if (b.type === 'text' && b.text.trim()) { said = true; push(c, { type: 'text', role: 'agent', engine, text: b.text }); }
          if (b.type === 'tool_use') push(c, { type: 'tool', engine, text: toolSummary(b.name, b.input) });
        }
        if (j.type === 'result') { if (j.session_id) c.claudeSession = j.session_id; if (j.is_error) resultError = String(j.result || j.subtype || 'error').slice(0, 300); }
      } else {
        if (j.type === 'thread.started') c.codexThread = j.thread_id;
        const it = j.item || {};
        if (j.type === 'item.completed' && it.type === 'agent_message' && it.text?.trim()) { said = true; push(c, { type: 'text', role: 'agent', engine, text: it.text }); }
        if (j.type === 'item.started' && it.type === 'command_execution') push(c, { type: 'tool', engine, text: toolSummary('Shell', { command: String(it.command).replace(/^\/bin\/bash -lc /, '') }) });
        if (j.type === 'turn.failed' || j.type === 'error') resultError = String(j.error?.message || j.message || 'error').slice(0, 300);
      }
    };
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    child.on('close', code => {
      clearTimeout(limit);
      if (buf.trim()) handle(buf);
      active = null;
      const ok = code === 0 && !resultError;
      resolve({ ok, said, error: resultError || (code ? (errTail.trim().split('\n').at(-1) || `exited ${code}`) : '') });
    });
    child.on('error', e => { errTail += e.message; });
  });
}

export async function startRepair({ convId, message, engine = 'auto', origin = 'owner' }) {
  if (active) throw Object.assign(new Error('A repair is already running. Wait for it to finish.'), { status: 409 });
  message = String(message || '').trim().slice(0, 8000);
  if (!message) throw Object.assign(new Error('Write what is wrong first.'), { status: 400 });
  let c = convId ? loadConv(convId) : null;
  if (convId && !c) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  if (!c) c = { id: crypto.randomBytes(8).toString('hex'), title: message.slice(0, 80), origin, createdAt: new Date().toISOString(), events: [] };
  c.running = true;
  push(c, { type: 'text', role: 'owner', text: message });
  const order = engine === 'chatgpt' ? ['chatgpt'] : engine === 'claude' ? ['claude'] : (c.lastEngine === 'chatgpt' ? ['chatgpt', 'claude'] : ['claude', 'chatgpt']);
  active = { convId: c.id, engine: order[0] }; // reserve before the async work starts
  (async () => {
    try {
      for (const [i, eng] of order.entries()) {
        push(c, { type: 'status', engine: eng, text: eng === 'claude' ? 'Claude is looking into it…' : 'ChatGPT is looking into it…' });
        const r = await runOnce(eng, c, message);
        if (r.ok || r.said) { c.lastEngine = eng; break; }
        const next = order[i + 1];
        push(c, { type: 'note', text: `${eng === 'claude' ? 'Claude' : 'ChatGPT'} couldn't answer (${r.error || 'no reply'}).${next ? ` Trying ${next === 'claude' ? 'Claude' : 'ChatGPT'} instead.` : ''}` });
      }
    } catch (e) {
      push(c, { type: 'note', text: `Repair stopped: ${e.message}` });
    } finally {
      active = null;
      c.running = false;
      push(c, { type: 'end' });
    }
  })();
  return { id: c.id };
}

export function stopRepair() {
  if (!active?.child) return false;
  try { process.kill(-active.child.pid, 'SIGTERM'); } catch {}
  return true;
}

// On service start, any conversation left "running" by a crash is closed honestly.
for (const f of fs.readdirSync(CONV_DIR)) {
  if (!f.endsWith('.json')) continue;
  const c = loadConv(f.slice(0, -5));
  if (c?.running) { c.running = false; push(c, { type: 'note', text: 'The Troubleshooter restarted while this repair was running.' }); push(c, { type: 'end' }); }
}

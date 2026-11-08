// Repair conversations: the owner talks directly to an AI model using a sign-in held by one of the box's Wizard
// connection apps (Claude app, ChatGPT app, Tinfoil app). No Hermes, no Agent Service, no Wizard shell in the path.
//   claude  — Claude Code CLI with only shared MCP repair tools, using the Claude app's login directory.
//   chatgpt — ChatGPT model called directly with the ChatGPT app's sign-in, in a bounded tool loop (lib/toolloop.mjs).
//   tinfoil — private Tinfoil model through the Tinfoil app's attested gateway, same bounded tool loop.
// Default order Claude → ChatGPT → Tinfoil; the owner can pick one engine. Runs are detached from the browser: the
// page polls, so a dropped connection never kills a repair.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CONFIG, wiring } from './checks.mjs';
import { P, META, ENGINES, engineOrder, signin, chatgptTurn, tinfoilTurn, nextReady, rememberClaudeModel, modelLabel, claudeLogins, markClaudeLimited } from './providers.mjs';
import { runLoop, scrub, toolDefs, callTool } from './toolloop.mjs';
import { plansOn, unreportedResults } from './repair-plan.mjs';
import { providerFailure, rememberProbe } from './reply-health.mjs';

const HOME = os.homedir();
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PROMPT = () => fs.readFileSync(path.join(APP, 'REPAIR_PROMPT.md'), 'utf8').replace('{{WIRING}}', wiring());
const BRIEF_OFF = `\n\n## Shared repair tools\nEvery provider has the same tools and permissions. Start with check_status for health issues, repair_scope for file/command repairs. read_file and write_file operate on the exact host-configured allowlist; run_command executes a fixed allowlisted argv, never arbitrary shell. Writes and commands wait for owner approval in the page and may be denied. File writes require a fresh sha256, keep a backup, and verify. Do not claim a repair succeeded without readback. A provider switch changes only the model, never authority. If scope is missing, explain the exact host policy grant needed; another provider cannot bypass it.`;
// With repair plans switched on (repair policy "plans": true) the model can read code and propose a concrete repair.
const BRIEF_PLANS = `\n\n## Shared repair tools\nEvery provider has the same tools and permissions. Diagnose with check_status, service_status, journal_tail, docker_logs, inspect_file, list_dir and search_text (all read-only). Restart-type fixes use run_fix. For anything else (a code or config fix, a command sequence) call propose_repair with ONE concrete plan: exact bash commands and/or exact file edits, plus verify commands. It runs only after the owner taps Approve on this page, with full write/exec power, backups of every touched file, a transcript and health checks afterwards; you never run it yourself and never claim it ran. The owner's next message carries the plan's result. A provider switch changes only the model, never authority.`;
const LOOP_BRIEF_NOW = () => plansOn() ? BRIEF_PLANS : BRIEF_OFF;
const CONV_DIR = path.join(CONFIG.stateDir, 'conversations');
const WORK = path.join(CONFIG.stateDir, 'work');
// Screenshots the owner attaches: kept per conversation, served back only to the owner-gated page.
const ATTACH = path.join(CONFIG.stateDir, 'attachments');
fs.mkdirSync(ATTACH, { recursive: true, mode: 0o700 });
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGES = 4, MAX_IMAGE_BYTES = 6 << 20;
function saveImages(convId, images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw Object.assign(new Error(`Attach at most ${MAX_IMAGES} screenshots.`), { status: 400 });
  const dir = path.join(ATTACH, convId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return images.map(img => {
    const m = typeof img?.dataUrl === 'string' && img.dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw Object.assign(new Error('Screenshots must be PNG, JPEG, WebP or GIF images.'), { status: 400 });
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('A screenshot is too large (6 MB at most).'), { status: 413 });
    const id = crypto.randomBytes(8).toString('hex'), file = path.join(dir, `${id}.${IMAGE_TYPES[m[1]]}`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    return { id, type: m[1], bytes: buf.length, name: String(img.name || '').replace(/[^\w .()-]/g, '').slice(0, 80) };
  });
}
export function attachmentFile(convId, id) {
  if (!validId(convId) || !/^[a-f0-9]{16}$/.test(String(id))) return null;
  const dir = path.join(ATTACH, convId);
  const f = (() => { try { return fs.readdirSync(dir).find(n => n.startsWith(id + '.')); } catch { return null; } })();
  if (!f) return null;
  const ext = f.split('.').pop();
  return { file: path.join(dir, f), type: Object.keys(IMAGE_TYPES).find(t => IMAGE_TYPES[t] === ext) || 'application/octet-stream' };
}
const loadImages = (convId, list = []) => list.map(i => { const a = attachmentFile(convId, i.id); if (!a) return null; return { ...i, file: a.file, dataUrl: `data:${a.type};base64,${fs.readFileSync(a.file).toString('base64')}` }; }).filter(Boolean);
fs.mkdirSync(CONV_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
const RUN_LIMIT_MS = +(process.env.REPAIR_RUN_LIMIT_MS || 20 * 60e3);
// Claude Code's default login directory is ~/.claude; only pass CLAUDE_CONFIG_DIR when the install names another one
// (setting it to the default would also move Claude Code's ~/.claude.json settings lookup).
const ENV = { ...process.env, PATH: `${path.join(HOME, '.local/bin')}:${process.env.PATH || '/usr/bin:/bin'}` };
delete ENV.ANTHROPIC_API_KEY; // always the Claude app's subscription login, never a stray API key
delete ENV.ANTHROPIC_AUTH_TOKEN;
delete ENV.OPENAI_API_KEY;

let active = null; // { convId, engine, child?, abort?, stopped? }
export const bridgeToken = crypto.randomBytes(32).toString('hex');
const approvals = new Map();
function authorize(c, request) {
  if (c.origin !== 'owner' || active?.stopped) return Promise.resolve(false);
  const id = crypto.randomBytes(16).toString('hex');
  return new Promise(resolve => {
    const finish = approved => { clearTimeout(timer); approvals.delete(id); push(c, { type: 'approval-result', approvalId: id, approved }); resolve(approved); };
    const timer = setTimeout(() => finish(false), 300000);
    approvals.set(id, { convId: c.id, finish });
    push(c, { type: 'approval', approvalId: id, text: scrub(JSON.stringify(request)) });
  });
}
export function decideApproval(id, convId, approved) {
  const a = approvals.get(id);
  if (!a || a.convId !== convId || active?.convId !== convId || active.stopped) throw Object.assign(new Error('Approval expired or not active'), { status: 409 });
  a.finish(approved === true); return { approved: approved === true };
}
export async function bridgeRequest(q) {
  if (q.method === 'tools/list') return { tools: toolDefs().map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) };
  if (q.method !== 'tools/call' || active?.engine !== 'claude' || active.stopped) throw new Error('No active Claude repair');
  const c = loadConv(active.convId);
  // Use the live conversation object so concurrent tool approvals never overwrite events.
  const live = active.conversation;
  if (!c || !live) throw new Error('No active conversation');
  const text = await callTool(q.params?.name, q.params?.arguments, { engine: 'claude', authorize: r => authorize(live, r), ...planCtx(live, 'claude') });
  return { content: [{ type: 'text', text }] };
}

// A proposed plan shows up in the conversation as its own event; the page fetches the plan itself to approve it.
const planCtx = (c, engine) => ({ convId: c.id, engine, onProposal: rec => push(c, { type: 'plan', planId: rec.id, engine, text: rec.plan.title }) });
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
// Past sessions, newest first. Only what the list needs: never the Claude session id or any event payload beyond
// the owner's first line (the automatic-check context the page appends is cut off).
export const firstLine = c => {
  const t = c.events?.find(e => e.type === 'text' && e.role === 'owner')?.text || c.title || '';
  return t.replace(/\n\n\[Automatic check right now:[\s\S]*$/, '').split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 120) || '';
};
export function listConvs(limit = 10) {
  limit = Math.max(1, Math.min(50, Math.floor(+limit) || 10));
  return fs.readdirSync(CONV_DIR).filter(f => f.endsWith('.json')).map(f => loadConv(f.slice(0, -5))).filter(c => c && c.updatedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
    .map(c => ({ id: c.id, title: c.title, first: firstLine(c), createdAt: c.createdAt || c.updatedAt, updatedAt: c.updatedAt, running: !!c.running, origin: c.origin, engine: c.lastEngine || null }));
}
// Keep the newest CONV_KEEP sessions (default 100, each already capped by message and event size). Never the running one.
const CONV_KEEP = Math.max(5, +(process.env.TROUBLESHOOT_KEEP_SESSIONS || 100));
export function pruneConvs(keep = CONV_KEEP, protect = active?.convId) {
  const all = fs.readdirSync(CONV_DIR).filter(f => f.endsWith('.json')).map(f => ({ f, t: fs.statSync(path.join(CONV_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  let removed = 0;
  for (const { f } of all.slice(keep)) { if (f === `${protect}.json`) continue; try { fs.unlinkSync(path.join(CONV_DIR, f)); removed++; } catch {} }
  return removed;
}
export const busy = () => active && { convId: active.convId, engine: active.engine };

function push(c, ev) {
  if (typeof ev.text === 'string') ev.text = scrub(ev.text); // nothing token-shaped is ever stored or shown
  ev.seq = (c.events.at(-1)?.seq || 0) + 1;
  ev.at = new Date().toISOString();
  c.events.push(ev);
  c.updatedAt = ev.at;
  saveConv(c);
}

function toolSummary(name, input = {}) {
  const label = name === 'Bash' ? 'Shell' : name;
  const s = input.command || input.description || input.file_path || input.pattern || input.url || '';
  return `${label}${s ? ': ' + String(s).replace(/\s+/g, ' ').slice(0, 160) : ''}`;
}

const priorTexts = c => c.events.filter(e => e.type === 'text').slice(0, -1).slice(-20).map(e => ({ role: e.role, text: e.text.slice(0, 1500), engine: e.engine }));
function history(c) {
  // When Claude hasn't seen the conversation yet (first turn, or the owner switched engines), give it the transcript.
  const prior = priorTexts(c);
  return prior.length ? `Conversation so far:\n${prior.map(e => `${e.role === 'owner' ? 'Owner' : META[e.engine]?.name || 'Assistant'}: ${e.text}`).join('\n')}\n\n---\nOwner's new message:\n` : '';
}

function runClaude(c, message, login = { env: {} }, images = []) {
  return new Promise(resolve => {
    const mcp = { mcpServers: { repair: { command: process.execPath, args: [path.join(APP, 'bin/repair-mcp.mjs')], env: { REPAIR_BRIDGE_URL: `http://127.0.0.1:${process.env.PORT || 9691}/troubleshoot/internal/repair-tools`, REPAIR_BRIDGE_TOKEN: bridgeToken } } } };
    // With screenshots the turn goes in on stdin as one stream-json user message (text + base64 image blocks).
    const prompt = history(c) + message;
    const viaStdin = images.length > 0;
    const args = ['-p', ...(viaStdin ? ['--input-format', 'stream-json'] : [prompt]), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp), '--allowedTools', 'mcp__repair__*', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--append-system-prompt', PROMPT() + LOOP_BRIEF_NOW()];
    let child;
    if (login.env.CLAUDE_CONFIG_DIR) fs.mkdirSync(login.env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
    try { child = spawn(P.claudeBin, args, { cwd: WORK, env: { ...ENV, ...login.env }, detached: true, stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ ok: false, error: e.message, said: false }); }
    if (viaStdin) {
      const content = [{ type: 'text', text: prompt }, ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.type, data: i.dataUrl.split(',')[1] } }))];
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    }
    active = { ...active, convId: c.id, child, engine: 'claude', conversation: c };
    let said = false, acted = false, buf = '', errTail = '', resultError = '', model = '';
    const limit = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} push(c, { type: 'note', text: 'Stopped after 20 minutes.' }); }, RUN_LIMIT_MS);
    const handle = line => {
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.type === 'system' && j.subtype === 'init') { push(c, { type: 'capabilities', engine: 'claude', tools: j.tools || [] }); if (j.model) { model = j.model; rememberClaudeModel(j.model); } }
      if (j.type === 'assistant') for (const b of j.message?.content || []) {
        if (j.message?.model === '<synthetic>') { if (b.type === 'text') resultError = b.text.slice(0, 300); continue; }
        if (b.type === 'text' && b.text.trim()) {
          if (providerFailure(b.text)) { resultError = b.text.slice(0, 1800); continue; }
          said = true; push(c, { type: 'text', role: 'agent', engine: 'claude', model: j.message?.model || model, modelLabel: modelLabel(j.message?.model || model), text: b.text });
        }
        if (b.type === 'tool_use') { acted = true; push(c, { type: 'tool', engine: 'claude', text: toolSummary(b.name, b.input) }); }
      }
      if (j.type === 'result') { if (j.session_id) c.claudeSession = j.session_id; if (j.is_error) resultError = String(j.result || resultError || j.subtype || 'error').slice(0, 1800); }
    };
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    child.on('close', code => {
      clearTimeout(limit);
      if (buf.trim()) handle(buf);
      const ok = code === 0 && !resultError && (said || acted);
      const err = resultError || (code ? (errTail.trim().split('\n').at(-1) || `exited ${code}`) : '');
      resolve({ ok, said, acted, error: err, ...providerFailure(err) });
    });
    child.on('error', e => { errTail += e.message; });
  });
}

async function runToolEngine(engine, c, message, info, images = []) {
  const abort = new AbortController();
  active = { ...active, convId: c.id, engine, abort };
  const limit = setTimeout(() => abort.abort(), RUN_LIMIT_MS);
  const turnFn = engine === 'chatgpt'
    ? a => chatgptTurn({ ...a, signal: abort.signal })
    : a => tinfoilTurn({ ...a, model: info.model, signal: abort.signal });
  try {
    const model = engine === 'chatgpt' ? P.chatgptModel : info.model;
    const emit = ev => push(c, ev.type === 'text' ? { ...ev, model, modelLabel: modelLabel(model) } : ev);
    push(c, { type: 'capabilities', engine, tools: toolDefs().map(t => t.name) });
    // Tinfoil's private models may not read images: they get a plain note instead of the pixels.
    const seen = engine === 'tinfoil' ? [] : images;
    const text = engine === 'tinfoil' && images.length ? `${message}\n\n[The owner attached ${images.length} screenshot(s); this model cannot view images, so ask them to describe what it shows if it matters.]` : message;
    return await runLoop({ engine, turnFn, instructions: PROMPT() + LOOP_BRIEF_NOW(), history: priorTexts(c), message: text, images: seen, emit, signal: abort.signal, authorize: r => authorize(c, r), toolCtx: planCtx(c, engine) });
  } catch (e) {
    return { ok: false, said: false, error: abort.signal.aborted ? 'stopped' : String(e.message || e).slice(0, 300), signin: !!e.signin, ...providerFailure(e.message) };
  } finally { clearTimeout(limit); }
}

// Same engine, same tools, next Claude sign-in: only when a sign-in is at its usage limit before it said or did
// anything, so a repair never runs twice.
async function runClaudeLogins(c, message, images = []) {
  const logins = claudeLogins();
  let r = { ok: false, said: false, error: 'no Claude sign-in' };
  for (const [i, login] of logins.entries()) {
    r = await runClaude(c, message, login, images);
    if (r.ok || r.said || r.acted || !r.limited || active?.stopped) return r;
    markClaudeLimited(login.id);
    if (logins[i + 1]) push(c, { type: 'note', text: `The ${login.label} is at its usage limit (${r.error}). Using the ${logins[i + 1].label} instead; same Claude, same tools.` });
  }
  return r;
}

export async function startRepair({ convId, message, engine = 'auto', origin = 'owner', images }) {
  if (active) throw Object.assign(new Error('A repair is already running. Wait for it to finish.'), { status: 409 });
  message = String(message || '').trim().slice(0, 8000);
  if (!message && Array.isArray(images) && images.length) message = 'Here is a screenshot of the problem.';
  if (!message) throw Object.assign(new Error('Write what is wrong first.'), { status: 400 });
  let c = convId ? loadConv(convId) : null;
  if (convId && !c) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  const fresh = !c;
  if (!c) c = { id: crypto.randomBytes(8).toString('hex'), title: message.slice(0, 80), origin, createdAt: new Date().toISOString(), events: [] };
  const attached = saveImages(c.id, images);
  c.running = true;
  push(c, { type: 'text', role: 'owner', text: message, ...(attached.length ? { images: attached } : {}) });
  // What happened to plans the model proposed earlier in this chat (approved, verified, failed, undone).
  const results = plansOn() ? unreportedResults(c.id) : '';
  if (results) message = `${message}\n\n${results}`;
  const pics = loadImages(c.id, attached);
  const order = engineOrder(engine);
  active = { convId: c.id, engine: order[0] }; // reserve before the async work starts
  if (fresh) pruneConvs(CONV_KEEP, c.id);
  (async () => {
    try {
      let answered = false;
      const picked = order.length === 1; // keep the preference; explain any automatic auth/limit fallback
      const offer = async eng => { if (!picked) return {}; const n = await nextReady(eng); return n ? { offer: n, offerName: META[n].name } : {}; };
      for (const [i, eng] of order.entries()) {
        if (active?.stopped) break;
        const m = META[eng]; let next = order[i + 1];
        const allowFallback = () => {
          if (!next && picked) { order.push(...ENGINES.filter(e => !order.includes(e))); next = order[i + 1]; }
        };
        const info = await signin(eng);
        if (!info.ok) {
          if (info.state === 'expired' || info.state === 'limited') allowFallback();
          push(c, { type: 'signin', state: info.state, engine: eng, app: m.app, open: info.open ?? m.open, installed: info.installed, appId: m.appId, text: `${info.detail}${next ? ` Trying ${META[next].name} instead.` : ''}`, ...(!next ? await offer(eng) : {}) });
          continue;
        }
        push(c, { type: 'status', engine: eng, via: m.app, text: m.statusText || `${m.name} is looking into it…` });
        const r = eng === 'claude' ? await runClaudeLogins(c, message, pics) : await runToolEngine(eng, c, message, info, pics);
        if (r.said || r.acted || (r.ok && !r.signin && !r.limited)) { c.lastEngine = eng; answered = true; break; }
        if (r.signin || r.limited) allowFallback();
        if (r.signin || r.limited) rememberProbe(CONFIG.stateDir, eng, { ok: false, state: r.signin ? 'expired' : 'limited', signin: !!r.signin, provider: m.name, detail: `${m.name} ${r.signin ? 'sign-in expired' : 'usage limit reached'}.` });
        if (active?.stopped) break;
        push(c, r.signin
          ? { type: 'signin', state: 'expired', engine: eng, app: m.app, open: info.open ?? m.open, installed: info.installed, appId: m.appId, text: `${m.name}'s sign-in has expired.${next ? ` ${META[next].name} is taking over.` : ` Sign in to ${m.name} again.`}`, ...(!next ? await offer(eng) : {}) }
          : { type: 'note', text: `${m.name} couldn't answer (${r.error || 'no reply'}).${next ? ` Trying ${META[next].name} instead.` : ''}`, ...(!next ? await offer(eng) : {}) });
      }
      if (!answered && !active?.stopped && !picked) push(c, { type: 'note', text: 'No AI could answer. Open the Claude, ChatGPT or Tinfoil app in Wizard to check its sign-in, or use the manual fixes in the details.' });
    } catch (e) {
      push(c, { type: 'note', text: `Repair stopped: ${e.message}` });
    } finally {
      for (const a of approvals.values()) if (a.convId === c.id) a.finish(false);
      active = null;
      c.running = false;
      push(c, { type: 'end' });
    }
  })();
  return { id: c.id, order };
}

export function stopRepair() {
  if (!active) return false;
  active.stopped = true;
  for (const a of approvals.values()) a.finish(false);
  if (active.child) { try { process.kill(-active.child.pid, 'SIGTERM'); } catch {} }
  if (active.abort) active.abort.abort();
  return true;
}

export { ENGINES };

// On service start, any conversation left "running" by a crash is closed honestly.
for (const f of fs.readdirSync(CONV_DIR)) {
  if (!f.endsWith('.json')) continue;
  const c = loadConv(f.slice(0, -5));
  if (c?.running) { c.running = false; push(c, { type: 'note', text: 'The Troubleshooter restarted while this repair was running.' }); push(c, { type: 'end' }); }
}

// Which AI answers the repair chat, and with whose sign-in. Every engine uses a sign-in held by one of the box's
// Wizard connection apps, read in place at call time. None of them goes through Hermes or the Agent Service:
//   claude  — the Claude app's sign-in: the Claude Code login directory the Claude app engine mounts (CLAUDE_CONFIG_DIR,
//             default ~/.claude). Claude Code uses the shared bounded repair tools and renews that login itself.
//   chatgpt — the ChatGPT app's sign-in. The ChatGPT app keeps no token of its own: it signs in through the agent's
//             credential store (credential_owner "hermes"), the file CHATGPT_AUTH_FILE (default ~/.hermes/auth.json).
//             We read the current access token from that file (Hermes does not need to be running) and call the
//             ChatGPT Codex endpoint directly. We never refresh it: refresh tokens are single-use and belong to the store.
//   tinfoil — the Tinfoil app's key. The key never leaves the app: we call the app's own box-only, attested
//             /v1/chat/completions gateway with its local gateway credential, read from the app's store at call time.
// Tokens, keys and gateway credentials are never logged, stored in conversations or returned by any route.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run, CONFIG } from './checks.mjs';
import { cachedProbe, knownProbe, replyResult, providerFailure } from './reply-health.mjs';
import { codexTurn } from './codex-turn.mjs';

const HOME = os.homedir();
export const P = {
  claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'),
  claudeBin: process.env.CLAUDE_BIN || path.join(HOME, '.local/bin/claude'),
  codexBin: process.env.CODEX_BIN || path.join(HOME, '.local/bin/codex'),
  codexHome: process.env.CODEX_HOME || path.join(HOME, '.codex'),
  chatgptAuthFile: process.env.CHATGPT_AUTH_FILE || path.join(HOME, '.hermes/auth.json'),
  chatgptBase: (process.env.CHATGPT_BASE_URL || 'https://chatgpt.com/backend-api/codex').replace(/\/$/, ''),
  chatgptModel: process.env.CHATGPT_MODEL || 'gpt-6.1-sol',
  tinfoilUrl: (process.env.TINFOIL_URL || 'http://127.0.0.1:18804').replace(/\/$/, ''),
  tinfoilContainer: process.env.TINFOIL_CONTAINER || 'wizard-tinfoil_wizardapps-wizard-tinfoil-1',
  tinfoilTokenFile: process.env.TINFOIL_TOKEN_FILE || '', // tests / non-Docker installs; otherwise read via docker exec
  tinfoilModel: process.env.TINFOIL_MODEL || '',
  appsFile: process.env.WIZARD_APPS_FILE || path.join(HOME, '.wizard-os/apps.json'),
};
export const ENGINES = ['claude', 'chatgpt', 'tinfoil'];
export const META = {
  claude: { name: 'Claude', statusText: 'Claude is looking into it…', app: 'Claude app', open: '/wizard-claude/', appId: 'wizard-claude' },
  chatgpt: { name: 'ChatGPT', statusText: 'ChatGPT is looking into it…', app: 'ChatGPT app', open: '/wizard-chatgpt/', appId: 'wizard-chatgpt' },
  tinfoil: { name: 'Tinfoil', app: 'Tinfoil app', open: '/wizard-tinfoil/', appId: 'wizard-tinfoil', private: true },
};
// Where the owner opens each connection app. App Manager's registry (~/.wizard-os/apps.json) says where this box
// actually serves it: on the shell's origin (/wizard-claude/) on some boxes, on the app's own HTTPS port on others.
// An app that isn't installed points at its App Store page instead. Without a registry, the META defaults stand.
const STORE = id => `/wizard-os-home/store/index.html?app=${encodeURIComponent(id)}`;
export function appLink(engine) {
  const m = META[engine];
  let reg;
  try { reg = JSON.parse(fs.readFileSync(P.appsFile, 'utf8')); } catch { return { open: m.open, installed: null }; }
  const a = (Array.isArray(reg?.apps) ? reg.apps : []).find(x => x && x.id === m.appId);
  if (!a) return { open: STORE(m.appId), installed: false };
  const u = String(a.view?.url || '');
  if (/^\/[A-Za-z0-9._~\/-]*$/.test(u) && !u.startsWith('//')) return { open: u, installed: true };
  try { const x = new URL(u); if (x.protocol === 'https:') return { open: x.href, installed: true }; } catch {}
  return { open: STORE(m.appId), installed: true };
}

// Human label for a model id, e.g. claude-opus-5-5 -> Opus 5.5, gpt-5.6-luna -> GPT-5.6 Luna, glm-5-3 -> GLM 5.3.
const WORDS = { gpt: 'GPT', glm: 'GLM', oss: 'OSS', deepseek: 'DeepSeek', llama: 'Llama', kimi: 'Kimi', qwen: 'Qwen', gemma: 'Gemma' };
export function modelLabel(id) {
  if (!id || typeof id !== 'string') return '';
  let s = id.replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
  s = s.replace(/(\d)-(\d)(?=-|$)/g, '$1.$2'); // 5-5 -> 5.5, v4-1 -> v4.1
  s = s.replace(/^([a-z]+)(\d)/, '$1 $2'); // llama3.3 -> llama 3.3
  return s.split('-').map(w => {
    if (/^gpt$|^glm$|^oss$/i.test(w)) return w.toUpperCase();
    const m = w.match(/^([a-z]+)(.*)$/i);
    if (!m) return w.toUpperCase();
    const head = WORDS[m[1].toLowerCase()] || (m[1].length === 1 ? m[1].toUpperCase() : m[1][0].toUpperCase() + m[1].slice(1));
    return head + m[2].toUpperCase();
  }).join(' ').replace(/^GPT (\d)/, 'GPT-$1').replace(/ OSS /, '-OSS ').replace(/^GPT-OSS/, 'GPT-OSS');
}
// Short reason shown on a disabled picker option.
export const REASON = { missing: 'Not signed in', expired: 'Sign-in expired', limited: 'Usage limit reached', unavailable: 'Not available' };

// The model Claude Code answers with for the Claude app's login. Claude Code reports it in its first stream event
// (before any request is made); we read it from there, cache it, and refresh it from every real repair run.
const CLAUDE_MODEL_FILE = () => path.join(CONFIG.stateDir, 'claude-model.json');
let claudeProbe = null;
export function rememberClaudeModel(model) {
  if (typeof model !== 'string' || !/^[\w.\-\[\]]{3,80}$/.test(model)) return;
  try { fs.writeFileSync(CLAUDE_MODEL_FILE(), JSON.stringify({ model, at: Date.now() }), { mode: 0o600 }); } catch {}
}
export async function claudeModel() {
  const c = readJson(CLAUDE_MODEL_FILE());
  if (c?.model && Date.now() - c.at < 6 * 3600e3) return c.model;
  claudeProbe ||= new Promise(resolve => {
    let child, buf = '', done = false;
    const finish = m => { if (done) return; done = true; clearTimeout(t); try { process.kill(-child.pid, 'SIGTERM'); } catch {} if (m) rememberClaudeModel(m); claudeProbe = null; resolve(m || c?.model || null); };
    const t = setTimeout(() => finish(null), 15000);
    const env = { ...process.env, PATH: `${path.join(HOME, '.local/bin')}:${process.env.PATH || '/usr/bin:/bin'}` };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
    try { child = spawn(P.claudeBin, ['-p', '.', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-chrome', '--permission-mode', 'dontAsk'], { cwd: CONFIG.stateDir, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return finish(null); }
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const j = JSON.parse(line); if (j.type === 'system' && j.subtype === 'init' && j.model) return finish(j.model); } catch {}
      }
    });
  });
  return claudeProbe;
}

export function engineOrder(choice, lastEngine) {
  const base = String(process.env.REPAIR_ENGINES || 'claude,chatgpt,tinfoil').split(',').map(s => s.trim()).filter(e => ENGINES.includes(e));
  if (ENGINES.includes(choice)) return [choice];
  return base;
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function jwtClaims(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}
const hint = e => `Open the ${META[e].app} in Wizard and sign in again.`;

// --- Claude app --------------------------------------------------------------------------------------------
// Every Claude subscription sign-in on the box, in the order a repair tries them:
//   1. the Claude app's login directory (Claude Code renews it itself);
//   2. Claude subscription sign-ins in the agent's credential store (CLAUDE_AGENT_AUTH_FILE, default the same
//      ~/.hermes/auth.json the ChatGPT app uses): OAuth entries of credential_pool.anthropic, by priority. These are
//      passed to Claude Code as CLAUDE_CODE_OAUTH_TOKEN with a private, empty config dir, read at call time, never
//      refreshed here (the store owns refresh) and never logged.
// One Claude sign-in hitting its usage limit gives way to the next one; the engine (and its tools) stay the same.
const claudeAppLogin = () => {
  const c = readJson(path.join(P.claudeDir, '.credentials.json'))?.claudeAiOauth;
  if (!c?.accessToken && !c?.refreshToken) return null;
  if ((+c.expiresAt || 0) && +c.expiresAt < Date.now() && !c.refreshToken) return null;
  return { id: 'app', label: 'Claude app sign-in', plan: c.subscriptionType || '', env: {} };
};
function claudeAgentLogins() {
  const a = readJson(process.env.CLAUDE_AGENT_AUTH_FILE || P.chatgptAuthFile);
  return (a?.credential_pool?.anthropic || []).slice().sort((x, y) => (x.priority ?? 0) - (y.priority ?? 0))
    .filter(e => e?.auth_type === 'oauth' && typeof e.access_token === 'string' && e.access_token.startsWith('sk-ant-oat')
      && (!e.expires_at_ms || +e.expires_at_ms > Date.now() + 60e3))
    .map((e, i) => ({ id: `agent-${i}`, label: `agent's Claude sign-in${e.label ? ` “${String(e.label).slice(0, 40)}”` : ''}`, plan: '',
      env: { CLAUDE_CODE_OAUTH_TOKEN: e.access_token, CLAUDE_CONFIG_DIR: path.join(CONFIG.stateDir, 'claude-agent-login') } }));
}
const claudeLimited = new Map(); // login id -> until (ms): a login at its usage limit is tried last for an hour
export function markClaudeLimited(id) { claudeLimited.set(id, Date.now() + 3600e3); }
export function claudeLogins() {
  const all = [claudeAppLogin(), ...claudeAgentLogins()].filter(Boolean);
  const limited = l => (claudeLimited.get(l.id) || 0) > Date.now();
  return [...all.filter(l => !limited(l)), ...all.filter(limited)];
}
export function claudeSignin() {
  const m = META.claude;
  if (!fs.existsSync(P.claudeBin)) return { engine: 'claude', ...m, ok: false, state: 'unavailable', noApp: true, detail: `Claude repairs need Claude Code installed for ${os.userInfo().username} on this server, so the Troubleshooter can't use Claude here yet. Pick ChatGPT or Tinfoil.` };
  const logins = claudeLogins();
  if (!logins.length) return { engine: 'claude', ...m, ok: false, state: 'missing', detail: `The Claude app has no sign-in. ${hint('claude')}` };
  const plan = logins.find(l => l.plan)?.plan;
  return { engine: 'claude', ...m, ok: true, state: 'ready', logins: logins.length, detail: `Signed in${plan ? ` (${plan})` : ''}${logins.length > 1 ? `, ${logins.length} Claude sign-ins` : ''}.` };
}

// --- ChatGPT app -------------------------------------------------------------------------------------------
// Every usable ChatGPT access token in the store, current sign-in first, then the pooled sign-ins by priority.
function chatgptTokens() {
  const a = readJson(P.chatgptAuthFile);
  const out = [a?.providers?.['openai-codex']?.tokens?.access_token,
    ...(a?.credential_pool?.['openai-codex'] || []).slice().sort((x, y) => (x.priority ?? 0) - (y.priority ?? 0)).map(e => e.access_token)];
  return [...new Set(out.filter(t => typeof t === 'string' && t.split('.').length === 3 && (jwtClaims(t)?.exp || 0) * 1000 > Date.now() + 60e3))];
}
function chatgptToken() {
  const a = readJson(P.chatgptAuthFile);
  const tok = a?.providers?.['openai-codex']?.tokens?.access_token || chatgptTokens()[0];
  return typeof tok === 'string' && tok.split('.').length === 3 ? tok : null;
}
export function chatgptSignin() {
  const m = META.chatgpt;
  const tok = chatgptToken();
  if (!tok) {
    const a = readJson(path.join(P.codexHome, 'auth.json'));
    if (fs.existsSync(P.codexBin) && a?.tokens?.access_token) return { engine: 'chatgpt', ...m, ok: true, state: 'ready', transport: 'codex', model: P.chatgptModel, detail: 'ChatGPT sign-in is held by Codex; a real reply check confirms it.' };
    return { engine: 'chatgpt', ...m, ok: false, state: 'missing', detail: `The ChatGPT app has no sign-in. ${hint('chatgpt')}` };
  }
  const cl = jwtClaims(tok) || {};
  const auth = cl['https://api.openai.com/auth'] || {};
  if (!auth.chatgpt_account_id) return { engine: 'chatgpt', ...m, ok: false, state: 'missing', detail: `The ChatGPT app's sign-in can't be read. ${hint('chatgpt')}` };
  if ((cl.exp || 0) * 1000 < Date.now() + 60e3 && !chatgptTokens().length) return { engine: 'chatgpt', ...m, ok: false, state: 'expired', detail: `The ChatGPT app's sign-in has expired. Open the ChatGPT app (it renews when your agent is running) or reconnect there.` };
  const email = cl['https://api.openai.com/profile']?.email;
  return { engine: 'chatgpt', ...m, ok: true, state: 'ready', model: P.chatgptModel, detail: `Signed in${email ? ` as ${email}` : ''}${auth.chatgpt_plan_type ? ` (${auth.chatgpt_plan_type})` : ''}.` };
}

// --- Tinfoil app -------------------------------------------------------------------------------------------
async function tinfoilStatus() {
  try {
    const r = await fetch(P.tinfoilUrl + '/api/status', { signal: AbortSignal.timeout(5000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
export async function tinfoilToken() {
  // The app's local gateway credential (not the Tinfoil key). Read at call time, held only in memory.
  let raw = null;
  if (P.tinfoilTokenFile) { try { raw = fs.readFileSync(P.tinfoilTokenFile, 'utf8'); } catch {} }
  else {
    const r = await run(CONFIG.docker, ['exec', P.tinfoilContainer, 'cat', '/data/private/gateway-token.json'], { timeout: 15000 });
    if (r.ok) raw = r.out;
  }
  try { const t = JSON.parse(raw).token; return typeof t === 'string' && t.length >= 16 ? t : null; } catch { return null; }
}
const TINFOIL_PREFERRED = ['glm-5-3', 'kimi-k3', 'gpt-oss-120b', 'deepseek-v4-1-flash', 'llama3-3-70b'];
export async function tinfoilSignin() {
  const m = META.tinfoil;
  const s = await tinfoilStatus();
  if (!s) return { engine: 'tinfoil', ...m, ok: false, state: 'unavailable', detail: 'The Tinfoil app is not answering on this server.' };
  if (s.status !== 'connected') return { engine: 'tinfoil', ...m, ok: false, state: s.credentialStored ? 'expired' : 'missing', detail: `The Tinfoil app has no working key. Open the Tinfoil app in Wizard and connect a key.` };
  const model = P.tinfoilModel && s.models?.includes(P.tinfoilModel) ? P.tinfoilModel : TINFOIL_PREFERRED.find(x => s.models?.includes(x));
  if (!model) return { engine: 'tinfoil', ...m, ok: false, state: 'unavailable', detail: 'The Tinfoil app has no chat model available.' };
  return { engine: 'tinfoil', ...m, ok: true, state: 'ready', model, detail: 'Key connected (private, attested).' };
}

export async function signin(engine) {
  const info = await (engine === 'claude' ? claudeSignin() : engine === 'chatgpt' ? chatgptSignin() : tinfoilSignin());
  const link = appLink(engine);
  // Nothing the owner can do in the app fixes a missing server-side program: no app button for that case.
  if (info.noApp) { delete info.noApp; return { ...info, ...link, open: '' }; }
  if (!info.ok && link.installed === false) info.detail = `The ${META[engine].app} isn't installed. Get it from the App Store, then sign in there.`;
  return { ...info, ...link };
}
export async function allSignins() {
  const list = await Promise.all(ENGINES.map(e => signin(e).catch(err => ({ engine: e, ...META[e], ...appLink(e), ok: false, state: 'unavailable', detail: String(err.message || err) }))));
  for (const a of list) {
    const live = knownProbe(CONFIG.stateDir, a.engine);
    if (live && !live.ok) Object.assign(a, { ok: false, state: live.state, detail: live.detail });
    if (a.engine === 'claude' && a.ok) a.model = await claudeModel();
    if (a.engine === 'chatgpt' && !a.model) a.model = P.chatgptModel;
    a.modelLabel = modelLabel(a.model);
    a.reason = a.ok ? '' : REASON[a.state] || 'Not available';
  }
  return list;
}

// The owner's picked engine, kept on the server so every device shows the same choice.
const PREFS = () => path.join(CONFIG.stateDir, 'prefs.json');
export function savedEngine() { const e = readJson(PREFS())?.engine; return ENGINES.includes(e) ? e : null; }
export function saveEngine(engine) {
  if (!ENGINES.includes(engine)) throw Object.assign(new Error('Unknown engine'), { status: 400 });
  const tmp = PREFS() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ engine, at: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(tmp, PREFS());
  return engine;
}
// Saved choice if there is one (even when its sign-in has lapsed: we never switch silently), else the first ready one.
export function selectedEngine(list) {
  return savedEngine() || list.find(a => a.ok)?.engine || engineOrder('auto')[0] || 'claude';
}
// The next engine that is ready, offered (not used) when the picked one can't answer.
export async function nextReady(engine) {
  for (const e of engineOrder('auto').filter(x => x !== engine)) { try { if ((await signin(e)).ok) return e; } catch {} }
  return null;
}

// --- Model calls (bounded tool loop engines) ----------------------------------------------------------------
// One turn: returns { text, calls: [{id, name, args}], replay } where replay is what goes back into the next request.
export async function chatgptTurn({ instructions, input, tools, signal }) {
  if (chatgptSignin().transport === 'codex') return codexTurn({ bin: P.codexBin, stateDir: CONFIG.stateDir, instructions, input, tools, model: P.chatgptModel, signal });
  const toks = chatgptTokens();
  if (!toks.length) throw Object.assign(new Error('ChatGPT sign-in missing or expired'), { signin: true });
  let r, body;
  // A sign-in that is rate limited or rejected gives way to the next one the ChatGPT app holds.
  for (const tok of toks) {
    const acct = jwtClaims(tok)?.['https://api.openai.com/auth']?.chatgpt_account_id || '';
    r = await fetch(P.chatgptBase + '/responses', {
      method: 'POST', signal,
      headers: { Authorization: 'Bearer ' + tok, 'ChatGPT-Account-ID': acct, 'Content-Type': 'application/json', Accept: 'text/event-stream', originator: 'wizard_troubleshooter', 'User-Agent': 'WizardTroubleshooter/0.2' },
      body: JSON.stringify({ model: P.chatgptModel, instructions, input, tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })), tool_choice: 'auto', parallel_tool_calls: false, store: false, stream: true }),
    });
    body = await r.text();
    if (![401, 403, 429].includes(r.status)) break;
  }
  if (!r.ok) {
    let msg = ''; try { msg = JSON.parse(body).detail || JSON.parse(body).error?.message || ''; } catch {}
    throw Object.assign(new Error(`ChatGPT answered ${r.status}${msg ? ': ' + String(msg).slice(0, 200) : ''}`), { signin: r.status === 401 || r.status === 403 });
  }
  let done = null;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { const ev = JSON.parse(line.slice(5)); if (ev.type === 'response.completed' || ev.type === 'response.done') done = ev.response; if (ev.type === 'response.failed') throw new Error(ev.response?.error?.message || 'ChatGPT failed'); } catch (e) { if (e.message && !/JSON/.test(e.message)) throw e; }
  }
  if (!done) throw new Error('ChatGPT sent no answer');
  if (done.model && done.model !== P.chatgptModel) throw new Error(`ChatGPT returned a different model (${done.model}); refusing silent model substitution`);
  const out = done.output || [];
  const text = out.filter(o => o.type === 'message').flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n').trim();
  const calls = out.filter(o => o.type === 'function_call').map(o => ({ id: o.call_id, name: o.name, args: o.arguments }));
  const replay = out.filter(o => o.type === 'message' || o.type === 'function_call').map(({ id, status, ...rest }) => rest);
  return { text, calls, replay };
}

export async function tinfoilTurn({ instructions, messages, tools, model, signal }) {
  const tok = await tinfoilToken();
  if (!tok) throw Object.assign(new Error("Can't read the Tinfoil app's local credential"), { signin: true });
  const r = await fetch(P.tinfoilUrl + '/v1/chat/completions', {
    method: 'POST', signal,
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: instructions }, ...messages], tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: 'auto' }),
  });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(`Tinfoil app answered ${r.status}${j.error ? ': ' + String(j.error).slice(0, 200) : ''}`), { signin: r.status === 401 || r.status === 409 });
  const msg = j.choices?.[0]?.message || {};
  const calls = (msg.tool_calls || []).map(c => ({ id: c.id, name: c.function?.name, args: c.function?.arguments }));
  const replay = { role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: msg.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments || '{}' } })) } : {}) };
  return { text: String(msg.content || '').trim(), calls, replay };
}

// Real requests, not auth-status metadata. Cache is shared by the page and the minute-by-minute guardian.
export async function engineReply(engine, options = {}) {
  return cachedProbe(CONFIG.stateDir, engine, async () => {
    const info = await signin(engine);
    if (!info.ok) return { ok: false, skipped: info.state === 'missing', state: info.state, detail: info.detail, provider: META[engine].name };
    if (engine === 'claude') {
      let last;
      for (const login of claudeLogins()) {
        const env = { ...process.env, ...login.env };
        delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
        if (login.env.CLAUDE_CONFIG_DIR) fs.mkdirSync(login.env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
        const r = await run(P.claudeBin, ['-p', 'Reply with just OK. Do not use tools.', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--permission-mode', 'dontAsk'], { timeout: 25000, env, cwd: CONFIG.stateDir });
        let text = '', error = '';
        for (const line of r.out.split('\n')) {
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.type === 'system' && j.model) rememberClaudeModel(j.model);
          if (j.type === 'assistant') text += (j.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          if (j.type === 'result' && j.is_error) error = j.result || j.subtype || 'error';
        }
        const failure = providerFailure(error || text || r.err);
        last = failure ? replyResult(error || text || r.err, 'Claude') : r.ok && !error ? replyResult(text, 'Claude') : { ok: false, state: 'unavailable', detail: 'Claude did not answer the reply check.' };
        if (last.ok || (!last.limited && !last.signin)) break;
      }
      return last;
    }
    try {
      const args = { instructions: 'Reply with just OK. Do not use tools.', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with just OK. Do not use tools.' }] }], messages: [{ role: 'user', content: 'Reply with just OK. Do not use tools.' }], tools: [], model: info.model, signal: AbortSignal.timeout(25000) };
      const r = await (engine === 'chatgpt' ? chatgptTurn(args) : tinfoilTurn(args));
      return replyResult(r.text, META[engine].name);
    } catch (e) {
      const f = providerFailure(e.message);
      return { ok: false, state: e.signin || f?.signin ? 'expired' : f?.limited ? 'limited' : 'unavailable', signin: !!(e.signin || f?.signin), provider: META[engine].name, detail: e.signin || f?.signin ? `${META[engine].name} sign-in expired.` : `${META[engine].name} could not answer the reply check.` };
    }
  }, options);
}

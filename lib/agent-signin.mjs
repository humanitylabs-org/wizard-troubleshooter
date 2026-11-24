// The chat agent's own AI sign-in (wizard-troubleshooter#62). 24 Nov 2026: the server's Claude Code login that
// Hermes answers every chat with expired (refresh token rejected, Hermes marked it dead) and no chat got a reply for
// six hours, while every check here was green: none of them looked at that sign-in. This reads only metadata:
// which provider Hermes's config names, the credential pool's own status marks (dead / exhausted, the reason), and
// the Claude login file's expiry, whether it holds a renewal token, and when it was written. Token values are never
// returned, logged or compared.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
export const TERMINAL_STEPS = 'Open a terminal on the server and run `claude`, then `/login`.';

export function envValue(text, name) {
  const m = String(text || '').match(new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'm'));
  return (m?.[1] || '').trim().replace(/^(["'])(.*)\1$/, '$2');
}

// Hermes's home on this box: its own (a host Hermes, HERMES_PORT set), else the app's data folder, which holds the
// auth.json App Manager hands us as CHATGPT_AUTH_FILE (a fresh box runs Hermes as the hermes-agent app).
export function agentHome(config) {
  if (process.env.AGENT_HERMES_HOME) return process.env.AGENT_HERMES_HOME;
  if (config.hermesPort) return config.hermesHome;
  return process.env.CHATGPT_AUTH_FILE ? path.dirname(process.env.CHATGPT_AUTH_FILE) : config.hermesHome;
}

// The main provider in Hermes's config.yaml (`model:` block `provider:`), without a YAML parser.
export function mainProvider(home) {
  const y = readText(path.join(home, 'config.yaml'));
  const block = y.match(/^model:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$)|[ \t]*(?:\r?\n|$))*)/m)?.[1] || '';
  const p = block.match(/^[ \t]+provider:[ \t]*["']?([\w.:-]+)/m)?.[1] || y.match(/^model:[ \t]*\{[^}]*provider:[ \t]*["']?([\w.:-]+)/m)?.[1] || '';
  return p.toLowerCase();
}
export const family = p => /^(anthropic|claude)/.test(p) ? 'claude' : /^(openai-codex|codex|chatgpt)/.test(p) ? 'chatgpt' : p ? 'other' : '';

// The folder the agent's Claude Code login lives in, as Hermes resolves it (wizard-app-manager wam/claude_login.py).
export function agentClaudeDir(home) {
  const env = readText(path.join(home, '.env'));
  for (const k of ['CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR', 'CLAUDE_CONFIG_DIR']) {
    const v = envValue(env, k) || '';
    if (v) return path.resolve(HOME, v.replace(/^~(?=\/|$)/, HOME));
  }
  return path.join(HOME, '.claude');
}

// Where a Claude login folder is repaired. App Manager can bind the Claude app's engine to the agent's folder
// (`wam alongside`, a user-config override marked x-wizard-claude-login): then the Claude app's Sign in renews it.
// Otherwise the folder is the server's own Claude Code login, which only `claude` → `/login` on the server renews;
// the Claude app keeps a separate sign-in of its own, so sending the owner there fixes nothing.
export function claudeAppHolds(dir) {
  const root = process.env.RUNTIPI_ROOT || path.join(HOME, 'runtipi');
  let stores = [];
  try { stores = fs.readdirSync(path.join(root, 'user-config')); } catch {}
  const want = path.resolve(dir);
  // A folder inside the Claude app's own data (runtipi app-data/<store>/wizard-claude/...) is the app's sign-in.
  if (/\/app-data\/[^/]+\/wizard-claude\//.test(want + '/')) return true;
  return stores.some(s => {
    const t = readText(path.join(root, 'user-config', s, 'wizard-claude', 'docker-compose.yml'));
    const m = /x-wizard-claude-login:/.test(t) && t.match(/^[ \t]+folder:[ \t]*["']?([^"'\r\n]+)/m);
    return !!m && path.resolve(m[1].trim()) === want;
  });
}
export function claudeLoginPlace(dir, { container = false } = {}) {
  // A fresh box's Hermes runs in the hermes-agent app and shares one volume with the Claude app.
  if (container || claudeAppHolds(dir)) return { login: 'claude-app', name: 'Claude app sign-in', howToFix: 'Open the Claude app in Wizard and sign in again.', open: '/wizard-claude/' };
  return { login: 'server', name: 'server sign-in', howToFix: TERMINAL_STEPS, open: '' };
}

const seconds = v => (typeof v === 'number' ? (v > 1e12 ? v / 1000 : v) : Date.parse(v) / 1000) || 0;
function claudeFile(dir) {
  const f = path.join(dir, '.credentials.json');
  const c = readJson(f)?.claudeAiOauth;
  if (!c) return null;
  return { access: !!c.accessToken, renew: !!c.refreshToken, expiresAt: +c.expiresAt || 0, writtenAt: mtime(f), plan: c.subscriptionType || '' };
}

// The state of the Claude login in `dir`, for the repair chat's own Claude (lib/providers.mjs): missing, expired
// (no renewal token left, or Hermes marked this same login dead and nobody signed in since) or ready.
export function claudeFolderState(dir, home) {
  const file = claudeFile(dir);
  if (!file || (!file.access && !file.renew)) return 'missing';
  if (file.expiresAt && file.expiresAt < Date.now() && !file.renew) return 'expired';
  if (path.resolve(agentClaudeDir(home)) === path.resolve(dir)) {
    const e = (readJson(path.join(home, 'auth.json'))?.credential_pool?.anthropic || []).find(x => x?.source === 'claude_code');
    if (e?.last_status === 'dead' && file.writtenAt <= seconds(e.last_status_at) * 1000 + 1000) return 'expired';
  }
  return 'ready';
}

// { ok, state: ready|missing|expired|unknown, provider, login, detail, howToFix, open, markedAt }
export function agentSignin(config, now = Date.now()) {
  const home = agentHome(config);
  const provider = mainProvider(home);
  const fam = family(provider);
  if (!fam) return { ok: true, state: 'unknown', detail: "Not checked: can't tell which AI your agent uses on this server." };
  const auth = readJson(path.join(home, 'auth.json')) || {};
  const env = readText(path.join(home, '.env'));
  const poolKey = fam === 'claude' ? 'anthropic' : fam === 'chatgpt' ? 'openai-codex' : provider;
  const pool = (Array.isArray(auth.credential_pool?.[poolKey]) ? auth.credential_pool[poolKey] : []).filter(e => e && typeof e === 'object');
  const marks = pool.filter(e => e.last_status && e.last_status !== 'ok').map(e => seconds(e.last_status_at) * 1000).filter(Boolean);
  const markedAt = marks.length ? Math.max(...marks) : 0;
  const reasonOf = e => String(e?.last_error_reason || '').replace(/[^\w .:-]/g, '').slice(0, 40);
  if (fam === 'claude') {
    const dir = agentClaudeDir(home);
    const place = claudeLoginPlace(dir, { container: !config.hermesPort });
    const file = config.hermesPort ? claudeFile(dir) : null;
    const base = { provider: 'Claude', login: place.login, howToFix: place.howToFix, open: place.open, markedAt };
    if (envValue(env, 'ANTHROPIC_API_KEY') || envValue(env, 'ANTHROPIC_TOKEN')) return { ok: true, state: 'ready', ...base, login: 'key', howToFix: '', open: '', detail: 'Your agent uses a Claude API key.' };
    // A dead pooled login stays dead until a new sign-in is written (Hermes re-syncs from the file only then).
    const fileEntry = pool.find(e => e.source === 'claude_code');
    const fileDead = fileEntry?.last_status === 'dead' && !(file && file.writtenAt > seconds(fileEntry.last_status_at) * 1000 + 1000);
    const fileLive = file && file.access && (!file.expiresAt || file.expiresAt > now || file.renew) && !fileDead;
    // Other pooled logins (and the pooled copy of the file's login, when the file can't be read from here).
    const others = pool.filter(e => e.last_status !== 'dead' && (e.source !== 'claude_code' || !file));
    if (fileLive || others.length) return { ok: true, state: 'ready', ...base, detail: `Your agent's Claude uses the ${fileLive ? place.name : 'sign-in saved in your agent'}${file?.plan && fileLive ? ` (${file.plan})` : ''}.` };
    // A fresh box keeps the login inside the app's volume: without a pooled copy there is nothing to read here.
    if (!file && !pool.length && !config.hermesPort) return { ok: true, state: 'unknown', ...base, detail: "Not checked: your agent's Claude sign-in is inside the agent app." };
    if (!file && !pool.length) return { ok: false, state: 'missing', ...base, detail: `Your agent has no Claude sign-in on this server, so chats get no reply. ${place.howToFix}` };
    const why = reasonOf(fileEntry);
    return { ok: false, state: 'expired', ...base, detail: `The ${place.name} your agent's Claude uses has expired${why ? ` (Claude refused to renew it: ${why})` : ''}, so chats get no reply. ${place.howToFix}` };
  }
  const base = { provider: fam === 'chatgpt' ? 'ChatGPT' : provider, login: fam === 'chatgpt' ? 'chatgpt-app' : 'agent', markedAt,
    howToFix: fam === 'chatgpt' ? 'Open the ChatGPT app in Wizard and sign in again.' : `On the server, run \`hermes auth add ${provider}\`.`, open: fam === 'chatgpt' ? '/wizard-chatgpt/' : '' };
  const single = fam === 'chatgpt' && auth.providers?.['openai-codex']?.tokens?.access_token;
  if (!pool.length) return single ? { ok: true, state: 'ready', ...base, detail: "Your agent's ChatGPT sign-in is there." } : { ok: true, state: 'unknown', ...base, detail: `Not checked: your agent's ${base.provider} sign-in isn't in its sign-in store.` };
  if (pool.some(e => e.last_status !== 'dead')) return { ok: true, state: 'ready', ...base, detail: `Your agent's ${base.provider} sign-in is there.` };
  const why = reasonOf(pool[0]);
  return { ok: false, state: 'expired', ...base, detail: `Your agent's ${base.provider} sign-in was refused${why ? ` (${why})` : ''}, so chats get no reply. ${base.howToFix}` };
}

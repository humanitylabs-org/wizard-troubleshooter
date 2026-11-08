// Owner-approved repair plans. The repair AI diagnoses with read-only tools, then proposes one concrete plan
// (shell commands and/or file edits plus a verify step). Nothing in a plan runs until the owner taps
// "Approve and run" on the Troubleshooter page, which binds the approval to the exact plan digest the page showed.
// The approved plan runs in its own transient user unit (bin/execute-plan.mjs) with real write/exec power as the
// service user, so it survives a restart of anything it repairs, including this service. Every touched file is
// backed up first, every step is written to a transcript, and the run ends with health checks. Undo restores the
// backups. Private agent data, Messenger data and recording content are refused at proposal and again at run time.
//
// Switched OFF by default. It is a grant in the existing per-box repair policy (REPAIR_POLICY_FILE, which grants
// nothing by default): `"plans": true` turns it on. Without it the model gets none of these tools, nothing can be
// approved and the executor refuses to run. Read on every call, so the owner/admin can turn it off without a restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { CONFIG, logIncident } from './checks.mjs';

const HOME = os.homedir();
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const PLANS = path.join(CONFIG.stateDir, 'repair-plans');
fs.mkdirSync(PLANS, { recursive: true, mode: 0o700 });
const PLAN_TTL_MS = +(process.env.REPAIR_PLAN_TTL_MS || 24 * 3600e3);
const MAX_STEPS = 20, MAX_COMMAND = 4000, MAX_CONTENT = 512 * 1024, MAX_STEP_S = 1800;
const READ_CAP = 200 * 1024;

// The switch: `"plans": true` in the repair policy file. A missing or unreadable policy means off.
export function plansOn() {
  const f = process.env.REPAIR_POLICY_FILE;
  if (!f) return false;
  try { return JSON.parse(fs.readFileSync(f, 'utf8'))?.plans === true; } catch { return false; }
}
const off = () => Object.assign(new Error('Repair plans are switched off on this Wizard (repair policy "plans": true turns them on).'), { status: 403 });

const expand = p => String(p || '').replace(/^~(?=$|\/)/, HOME).replace(/^\$\{?HOME\}?(?=$|\/)/, HOME);

// ---------- protected data ----------
// Private agents are the agents whose agent.json says privacy is not "standard" (an unreadable agent.json counts
// as private). Their Wizard directory and their app-data volume are both refused.
function privateAgents() {
  const dir = path.join(HOME, '.wizard-os/agents'), out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    let privacy = 'private';
    try { privacy = JSON.parse(fs.readFileSync(path.join(dir, n, 'agent.json'), 'utf8')).privacy || 'standard'; } catch {}
    if (privacy !== 'standard') out.push(n);
  }
  return out;
}
export function protectedRoots() {
  const appData = process.env.WIZARD_APP_DATA || path.join(HOME, 'runtipi/app-data/wizardapps');
  const roots = [
    path.join(HOME, '.ssh'),
    // Messenger data
    path.join(HOME, '.wizard-os/messenger-owner'), path.join(appData, 'messenger'),
    path.join(HOME, '.local/share/messenger-owner-signer'), path.join(HOME, '.local/state/messenger-rollback'),
    // Recording content
    path.join(appData, 'mizel'), path.join(HOME, '.local/share/mizel'), path.join(HOME, '.hermes/data/apps/meetings'),
    path.join(HOME, '.hermes/data/apps/mizel-live'), path.join(HOME, '.hermes/data/apps/wizard-voice'),
    path.join(HOME, '.local/share/wizardos-private-transcription'), path.join(HOME, '.local/state/wizardos-private-transcription'),
  ];
  for (const a of privateAgents()) roots.push(path.join(HOME, '.wizard-os/agents', a), path.join(appData, `agent-${a}`));
  for (const extra of String(process.env.REPAIR_PROTECT || '').split(':').filter(Boolean)) roots.push(path.resolve(expand(extra)));
  return [...new Set(roots)];
}
const under = (p, root) => p === root || p.startsWith(root + '/');
// Sign-in material is never read or written through a plan's file steps (commands may still restart the apps
// that own it). Names only; nothing is opened to decide.
const SECRET_NAME = /(?:^|\/)(?:\.env(?:\.[\w-]+)?|auth\.json|\.credentials\.json|credentials?(?:\.json)?|[^/]*(?:secret|password|passwd|private[_-]?key)[^/]*|[^/]*token(?:\.json|\.txt)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|keystore|jks))$/i;
const SECRET_DIR = /(?:^|\/)(?:secrets?|app-secrets|app-tokens|owner-proof|\.gnupg|\.password-store)(?:\/|$)/i;

function realish(p) {
  // Resolve symlinks on the longest existing prefix so a link can't smuggle a protected target past the check.
  let cur = p, rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    rest.unshift(path.basename(cur)); cur = parent;
  }
}
export function pathRefusal(p, { write = false, read = false } = {}) {
  if (typeof p !== 'string' || !p) return 'needs a file path';
  const abs = expand(p);
  if (!path.isAbsolute(abs) || path.normalize(abs).replace(/\/$/, '') !== abs.replace(/\/$/, '')) return 'path must be absolute and normal';
  const real = realish(abs);
  for (const root of protectedRoots()) if (under(abs, root) || under(real, root)) return 'is private data (private agents, Messenger or recordings) and is never touched';
  if ((read || write) && (SECRET_NAME.test(real) || SECRET_DIR.test(real))) return 'looks like a sign-in or secret file and is never read or written here';
  if (write && (under(real, PLANS) || real === path.join(APP, 'lib/repair-plan.mjs') || real === path.join(APP, 'bin/execute-plan.mjs'))) return 'is the approval machinery itself';
  return '';
}
// Commands are shell text. Refuse any that names protected data directly, through ~ or $HOME, or with a glob over
// the agents directory that would reach a private agent. Best effort by design: the owner's tap is the real gate.
export function commandRefusal(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return 'empty command';
  if (cmd.length > MAX_COMMAND) return 'command too long';
  const forms = root => {
    const rel = root.startsWith(HOME + '/') ? root.slice(HOME.length + 1) : null;
    return [root, ...(rel ? [`~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`] : [])];
  };
  for (const root of protectedRoots()) for (const f of forms(root)) {
    const i = cmd.indexOf(f);
    if (i >= 0 && !/[\w.-]/.test(cmd[i + f.length] || '')) return `touches private data (${f.replace(HOME, '~')})`;
  }
  if (/\.wizard-os\/agents\/?(?:\*|\{|\[|\s|$|["';|&)])/.test(cmd) || /runtipi\/app-data\/wizardapps\/(?:agent-)?\*/.test(cmd)) return 'reaches across every agent, including private ones';
  return '';
}

// ---------- plan shape ----------
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}` : JSON.stringify(v);
export const digestOf = plan => crypto.createHash('sha256').update(canon(plan)).digest('hex');
export function normalizePlan(input) {
  const err = m => { throw Object.assign(new Error(m), { status: 400 }); };
  if (!input || typeof input !== 'object') err('A plan needs a title, a diagnosis and steps.');
  const title = String(input.title || '').trim().slice(0, 160), diagnosis = String(input.diagnosis || '').trim().slice(0, 4000);
  if (!title || !diagnosis) err('A plan needs a short title and the diagnosis it fixes.');
  const raw = Array.isArray(input.steps) ? input.steps : [];
  if (!raw.length || raw.length > MAX_STEPS) err(`A plan needs 1 to ${MAX_STEPS} steps.`);
  const steps = raw.map((s, i) => {
    const n = `Step ${i + 1}`;
    if (!s || typeof s !== 'object') err(`${n} is not a step.`);
    const why = String(s.why || '').trim().slice(0, 400);
    if (s.action === 'run') {
      const r = commandRefusal(s.command); if (r) err(`${n} refused: ${r}.`);
      const timeout_s = Math.max(5, Math.min(MAX_STEP_S, Math.floor(+s.timeout_s || 300)));
      return { action: 'run', command: s.command, timeout_s, ...(why ? { why } : {}) };
    }
    if (s.action === 'edit' || s.action === 'write') {
      const p = expand(s.path), r = pathRefusal(p, { write: true }); if (r) err(`${n} refused: ${s.path} ${r}.`);
      if (s.action === 'edit') {
        if (typeof s.find !== 'string' || !s.find || typeof s.replace !== 'string') err(`${n}: an edit needs exact "find" text and its "replace" text.`);
        if (s.find.length + s.replace.length > MAX_CONTENT) err(`${n}: edit too large.`);
        return { action: 'edit', path: p, find: s.find, replace: s.replace, ...(why ? { why } : {}) };
      }
      if (typeof s.content !== 'string' || Buffer.byteLength(s.content) > MAX_CONTENT) err(`${n}: a write needs the whole new file content (at most 512 KB).`);
      return { action: 'write', path: p, content: s.content, ...(why ? { why } : {}) };
    }
    err(`${n}: action must be "run", "edit" or "write".`);
  });
  const verify = (Array.isArray(input.verify) ? input.verify : []).slice(0, 10).map((c, i) => { const r = commandRefusal(c); if (r) err(`Verify ${i + 1} refused: ${r}.`); return c; });
  return { title, diagnosis, steps, verify };
}

// ---------- storage ----------
const validPlanId = id => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id);
const dirOf = id => path.join(PLANS, id);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(t, f); };
export function createPlan(input, { convId = null, engine = null } = {}) {
  const plan = normalizePlan(input);
  const id = crypto.randomBytes(8).toString('hex'), dir = dirOf(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rec = { id, convId, engine, createdAt: new Date().toISOString(), digest: digestOf(plan), plan };
  writeJson(path.join(dir, 'plan.json'), rec);
  logIncident({ kind: 'repair-plan-proposed', plan: id, conversation: convId, title: plan.title, engine });
  return rec;
}
export function planState(id) {
  if (!validPlanId(id)) return null;
  const dir = dirOf(id), rec = readJson(path.join(dir, 'plan.json'));
  if (!rec) return null;
  const approval = readJson(path.join(dir, 'approval.json')), dismissed = readJson(path.join(dir, 'dismissed.json'));
  const run = readJson(path.join(dir, 'run.json')), undoAsked = fs.existsSync(path.join(dir, 'undo-request.json'));
  const undo = readJson(path.join(dir, 'undo.json')) || (undoAsked ? { state: 'running' } : null);
  const expired = !approval && !dismissed && Date.now() - Date.parse(rec.createdAt) > PLAN_TTL_MS;
  const state = undo ? (undo.state === 'running' ? 'undoing' : 'undone') : run ? run.state : approval ? 'starting' : dismissed ? 'dismissed' : expired ? 'expired' : 'proposed';
  let transcript = '';
  try { const t = fs.readFileSync(path.join(dir, 'transcript.log'), 'utf8'); transcript = t.length > 20000 ? '…\n' + t.slice(-20000) : t; } catch {}
  return { ...rec, state, approval, dismissed, run, undo, transcript, transcriptFile: path.join(dir, 'transcript.log') };
}
export function listPlans({ convId, limit = 20 } = {}) {
  let ids = [];
  try { ids = fs.readdirSync(PLANS).filter(validPlanId); } catch {}
  return ids.map(planState).filter(p => p && (!convId || p.convId === convId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
    .map(({ transcript, ...p }) => ({ ...p, transcriptTail: transcript.slice(-1500) }));
}
// Results the conversation's model hasn't heard about yet, for the owner's next message.
export function unreportedResults(convId) {
  const out = [];
  for (const p of listPlans({ convId, limit: 10 })) {
    const done = p.undo?.state === 'done' ? p.undo : ['succeeded', 'failed'].includes(p.run?.state) ? p.run : null;
    if (!done || fs.existsSync(path.join(dirOf(p.id), 'reported'))) continue;
    fs.writeFileSync(path.join(dirOf(p.id), 'reported'), new Date().toISOString(), { mode: 0o600 });
    out.push(`[Repair plan "${p.plan.title}" ${p.undo ? 'was undone' : p.run.state === 'succeeded' ? 'ran and verified OK' : 'ran and FAILED'}. Transcript end:\n${p.transcriptTail.slice(-1200)}]`);
  }
  return out.join('\n');
}

// ---------- approval gate ----------
const conflict = m => Object.assign(new Error(m), { status: 409 });
let launcher = null; // tests replace the unit launcher; production uses systemd-run
export function setLauncher(fn) { launcher = fn; }
function launch(id, mode) {
  const dir = dirOf(id), args = [path.join(APP, 'bin/execute-plan.mjs'), dir, ...(mode === 'undo' ? ['--undo'] : [])];
  if (launcher) return launcher({ id, dir, args, mode });
  const unit = `wizard-repair-${id}${mode === 'undo' ? '-undo' : ''}`;
  const env = { PATH: `${path.join(HOME, '.local/bin')}:/usr/local/bin:/usr/bin:/bin`, HOME, TROUBLESHOOT_STATE: CONFIG.stateDir,
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|TS_SOCKET|HERMES_PORT|HERMES_UNIT|AGENT_PORT|AGENT_UNIT|SHELL_PORT|REPAIR_HEALTH_URLS|REPAIR_PROTECT|REPAIR_POLICY_FILE|WIZARD_APP_DATA|LANG)$/.test(k))) };
  try {
    // Its own transient unit: the run outlives a restart of this service, Hermes or the Agent Service.
    execFileSync('systemd-run', ['--user', '--collect', `--unit=${unit}`, '--description=Wizard owner-approved repair', `--working-directory=${HOME}`,
      ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), process.execPath, ...args], { timeout: 15000, stdio: 'ignore' });
    return { via: 'systemd-run', unit };
  } catch {
    const child = spawn(process.execPath, args, { cwd: HOME, env: { ...process.env, ...env }, detached: true, stdio: 'ignore' });
    child.unref();
    return { via: 'detached', pid: child.pid };
  }
}
// The page shows the plan with its digest; approving sends that digest back. A plan that changed, expired, was
// dismissed or already ran is refused. This is the only way a plan starts.
export function approvePlan(id, digest, by) {
  if (!plansOn()) throw off();
  const p = planState(id);
  if (!p) throw Object.assign(new Error('Repair plan not found.'), { status: 404 });
  if (p.state !== 'proposed') throw conflict(`This plan is ${p.state}; it can't be approved now.`);
  if (typeof digest !== 'string' || digest !== p.digest || digestOf(p.plan) !== p.digest) throw conflict('The plan changed since it was shown. Reload and review it again.');
  normalizePlan(p.plan); // protected-data rules may have tightened since it was proposed
  const approval = { by: String(by || 'owner'), at: new Date().toISOString(), digest };
  try { fs.writeFileSync(path.join(dirOf(id), 'approval.json'), JSON.stringify(approval), { mode: 0o600, flag: 'wx' }); }
  catch { throw conflict('This plan was already approved.'); }
  logIncident({ kind: 'repair-plan-approved', plan: id, by: approval.by, title: p.plan.title });
  const how = launch(id, 'run');
  return { approved: true, ...how };
}
export function dismissPlan(id, by) {
  const p = planState(id);
  if (!p) throw Object.assign(new Error('Repair plan not found.'), { status: 404 });
  if (p.state !== 'proposed') throw conflict(`This plan is ${p.state}.`);
  fs.writeFileSync(path.join(dirOf(id), 'dismissed.json'), JSON.stringify({ by, at: new Date().toISOString() }), { mode: 0o600 });
  logIncident({ kind: 'repair-plan-dismissed', plan: id, by });
  return { dismissed: true };
}
export function undoPlan(id, by) {
  const p = planState(id);
  if (!p) throw Object.assign(new Error('Repair plan not found.'), { status: 404 });
  if (!['succeeded', 'failed'].includes(p.state) || !p.run?.backups?.length) throw conflict('Nothing to undo for this plan.');
  try { fs.writeFileSync(path.join(dirOf(id), 'undo-request.json'), JSON.stringify({ by, at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' }); }
  catch { throw conflict('Undo was already requested.'); }
  logIncident({ kind: 'repair-plan-undo', plan: id, by });
  return { undoing: true, ...launch(id, 'undo') };
}

// ---------- read-only inspection + proposal tools (shared by every engine) ----------
export function planDefs() {
  if (!plansOn()) return [];
  const step = { type: 'object', properties: {
    action: { type: 'string', enum: ['run', 'edit', 'write'], description: 'run: a bash command. edit: replace exact unique text in a file. write: replace a whole file.' },
    command: { type: 'string', description: 'For run: the bash command (runs as the service user with full write/exec power once approved).' },
    timeout_s: { type: 'integer', minimum: 5, maximum: MAX_STEP_S },
    path: { type: 'string', description: 'For edit/write: absolute file path.' },
    find: { type: 'string', description: 'For edit: exact text that appears exactly once in the file now.' },
    replace: { type: 'string', description: 'For edit: the replacement text.' },
    content: { type: 'string', description: 'For write: the complete new file content.' },
    why: { type: 'string', description: 'One plain sentence for the owner.' },
  }, required: ['action'], additionalProperties: false };
  return [
    { name: 'inspect_file', description: 'Read-only: read any non-secret text file on this server (source code, configs, unit files, logs) to diagnose. Private agent data, Messenger data, recordings and sign-in files are refused. Optional 1-based line offset and line limit (default 400).', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['path'], additionalProperties: false } },
    { name: 'list_dir', description: 'Read-only: list one directory (names, sizes, modified times).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
    { name: 'search_text', description: 'Read-only: grep for a fixed string or regular expression under one directory or file (at most 200 matching lines).', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern', 'path'], additionalProperties: false } },
    { name: 'propose_repair', description: 'When you have a diagnosis that the fixed one-tap fixes cannot solve, propose ONE concrete repair plan: ordered steps (bash commands and/or exact file edits) and verify commands. It does NOT run now. The owner sees the exact plan on the Troubleshooter page and taps Approve; then it runs with full write/exec power, every touched file backed up first, a full transcript kept, and standard health checks (Hermes, Agent Service, Wizard) run afterwards. Keep it minimal and reversible. Never touch private agents, Messenger data or recordings. After proposing, tell the owner in one or two plain sentences what it will do and that it waits for their tap; never claim it ran.', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Short plain title, e.g. "Fix the crash in Hermes chat turns".' }, diagnosis: { type: 'string', description: 'What is broken and the evidence, in plain words.' }, steps: { type: 'array', items: step, minItems: 1, maxItems: MAX_STEPS }, verify: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Extra bash commands that must exit 0 when the repair worked.' } }, required: ['title', 'diagnosis', 'steps'], additionalProperties: false } },
  ];
}
function readText(p, offset = 1, limit = 400) {
  const r = pathRefusal(p, { read: true }); if (r) return `Refused: ${p} ${r}.`;
  const abs = expand(p);
  let st; try { st = fs.statSync(abs); } catch { return `Not found: ${abs}`; }
  if (!st.isFile()) return `Not a regular file: ${abs}`;
  const fd = fs.openSync(abs, 'r'), buf = Buffer.alloc(Math.min(st.size, 8 << 20));
  try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  if (buf.subarray(0, 8000).includes(0)) return `Binary file (${st.size} bytes); not shown.`;
  const lines = buf.toString('utf8').split('\n'), from = Math.max(1, offset), to = Math.min(lines.length, from + Math.min(2000, limit) - 1);
  let out = lines.slice(from - 1, to).map((l, i) => `${from + i}|${l}`).join('\n');
  if (out.length > READ_CAP) out = out.slice(0, READ_CAP) + '\n… (cut)';
  return `${abs} (${lines.length} lines, showing ${from}-${to})\n${out}`;
}
export async function planTool(name, args, ctx = {}) {
  if (!plansOn()) return 'Refused: repair plans are switched off on this Wizard.';
  try {
    if (name === 'inspect_file') return readText(args.path, args.offset, args.limit);
    if (name === 'list_dir') {
      const r = pathRefusal(args.path); if (r) return `Refused: ${args.path} ${r}.`;
      const abs = expand(args.path);
      const ents = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 400);
      return ents.map(e => { let s = ''; try { const st = fs.lstatSync(path.join(abs, e.name)); s = `${st.size}\t${st.mtime.toISOString().slice(0, 16)}`; } catch {} const hidden = pathRefusal(path.join(abs, e.name)) ? ' (private: not opened)' : ''; return `${e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : '-'}\t${s}\t${e.name}${hidden}`; }).join('\n') || '(empty)';
    }
    if (name === 'search_text') {
      const r = pathRefusal(args.path); if (r) return `Refused: ${args.path} ${r}.`;
      const abs = expand(args.path);
      // grep itself never descends into protected data: each root under the search is excluded.
      const excl = protectedRoots().filter(root => under(root, abs)).flatMap(root => ['--exclude-dir', path.basename(root)]);
      const { execFile } = await import('node:child_process');
      return await new Promise(resolve => execFile('grep', ['-rIn', '-E', '-m', '20', '--exclude-dir=node_modules', '--exclude-dir=.git', ...excl, '--exclude=*.sqlite*', '--exclude=*.db', '--exclude=.env*', '--exclude=auth.json', '--exclude=*credential*', '--exclude=*secret*', '--exclude=*token*', '--', String(args.pattern), abs], { timeout: 20000, maxBuffer: 4 << 20 }, (e, out) => {
        const lines = String(out || '').split('\n').filter(l => l && !pathRefusal(l.split(':')[0], { read: true })).slice(0, 200);
        resolve(lines.length ? lines.map(l => l.slice(0, 400)).join('\n') : 'No matches.');
      }));
    }
    if (name === 'propose_repair') {
      const rec = createPlan(args, { convId: ctx.convId || null, engine: ctx.engine || null });
      ctx.onProposal?.(rec);
      return JSON.stringify({ proposed: true, plan: rec.id, note: 'Saved and shown to the owner. It runs only after they tap Approve on the Troubleshooter page. Tell them in plain words what it will do and that it is waiting for their tap. Do not say it ran.' });
    }
  } catch (e) { return `Refused: ${e.message}`; }
  return `Error: unknown tool ${name}.`;
}

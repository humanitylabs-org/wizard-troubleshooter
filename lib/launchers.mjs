// App addresses: every installed app that opens inside Wizard at a same-origin path (/messenger/, /files/) must keep
// that path as its launcher address (apps.json view.url). When something rewrites it to a raw port (2 Nov 2026: an
// older wam copy in the Builder bundle moved Messenger to https://<box>:9245/, a dead screen behind its owner
// gateway), this check notices and the repair re-runs the box's own `wam links`, after backing up the files it
// rewrites. Stdlib only; the repair never edits apps.json or links.json itself and never touches Serve routes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LIVE = new Set([undefined, null, 'running', 'starting', 'restarting', 'updating']);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const samePath = u => typeof u === 'string' && u.startsWith('/') && !u.startsWith('//');

export function launcherFiles(env = process.env) {
  const home = env.WIZARD_OS_HOME || path.join(os.homedir(), '.wizard-os');
  const cfg = readJson(path.join(home, 'app-manager.json')) || {};
  const runtipi = env.RUNTIPI_ROOT || cfg.runtipi_root || path.join(os.homedir(), 'runtipi');
  return {
    home,
    links: path.join(home, 'links.json'),
    apps: path.join(home, 'apps.json'),
    shared: path.join(runtipi.replace(/^~(?=\/)/, os.homedir()), 'app-data', 'wizard-os', 'apps.json'),
    lock: path.join(home, '.links.lock'),
  };
}

// Same-origin paths each app is known to open at: the current links.json, plus every path this check has seen in
// apps.json before (remembered), so a run that rewrote links.json AND apps.json to a raw port is still caught.
export function inspect(files, remembered = {}) {
  const links = readJson(files.links);
  const regs = [files.apps, files.shared].map(f => ({ file: f, reg: readJson(f) })).filter(x => x.reg);
  if (!regs.length) return { ok: true, skipped: true, detail: 'No app registry yet.', remembered, problems: [] };
  const installed = new Map();
  for (const { reg } of regs) for (const a of reg.apps || []) if (a?.id) installed.set(a.id, a);
  const known = {};
  for (const [id, p] of Object.entries(remembered || {})) if (installed.has(id) && samePath(p)) known[id] = p;
  for (const l of links?.links || []) if (l?.id && samePath(l.open) && installed.has(l.id)) known[l.id] = l.open;
  const problems = [];
  for (const { file, reg } of regs) {
    for (const a of reg.apps || []) {
      const want = known[a?.id];
      if (!want || !a.view || !LIVE.has(a.status)) continue;   // stopped apps are unpublished on purpose
      const got = a.view.url;
      if (got !== want) problems.push({ id: a.id, name: a.name || a.id, want, got: String(got || ''), file });
    }
  }
  // Learn the addresses that are correct right now (only from the owner's registry, never from a mismatch).
  const next = { ...known };
  const own = regs.find(x => x.file === files.apps)?.reg;
  for (const a of own?.apps || []) if (a?.id && samePath(a.view?.url) && !problems.some(p => p.id === a.id)) next[a.id] = a.view.url;
  if (!problems.length) return { ok: true, detail: `${Object.keys(next).length} apps open inside Wizard at their own path.`, remembered: next, problems };
  const first = problems[0];
  const names = [...new Set(problems.map(p => p.name))];
  return {
    ok: false,
    detail: `${names.join(', ')} ${names.length > 1 ? 'open' : 'opens'} at ${first.got || 'no address'} instead of ${first.want}${links?.errors?.[first.id] ? ` (${String(links.errors[first.id]).slice(0, 160)})` : ''}.`,
    remembered: next,
    problems,
  };
}

export function loadRemembered(stateDir) {
  return readJson(path.join(stateDir, 'launchers.json'))?.paths || {};
}

export function saveRemembered(stateDir, paths) {
  const f = path.join(stateDir, 'launchers.json');
  const body = JSON.stringify({ paths }, null, 1);
  try { if (fs.readFileSync(f, 'utf8') === body) return; } catch {}
  fs.writeFileSync(f + '.tmp', body, { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
}

// Copies of the three files `wam links` rewrites, under stateDir/launcher-backups/<time>/ (the last 20 are kept).
export function backup(files, stateDir, now = new Date()) {
  const root = path.join(stateDir, 'launcher-backups');
  const dir = path.join(root, now.toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const saved = [];
  for (const [name, f] of [['links.json', files.links], ['apps.json', files.apps], ['shared-apps.json', files.shared]]) {
    try { fs.copyFileSync(f, path.join(dir, name)); fs.chmodSync(path.join(dir, name), 0o600); saved.push(name); } catch {}
  }
  const all = fs.readdirSync(root).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 20))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
  return { dir, saved };
}

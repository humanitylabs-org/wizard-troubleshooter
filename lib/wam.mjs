// Which App Manager command (`wam`) may a repair use?
//
// The guardian and the one-tap fixes run `wam` to republish app addresses and to recreate the Agent Service. A copy of
// `wam` that is older than the App Manager actually running on the box is dangerous: on 2 Nov 2026 an old copy rewrote
// Messenger's address to a raw port and left a dead screen. So a repair never takes "whatever is at ~/.local/bin/wam".
// It finds the App Manager that is running (the checkout its API service starts from), accepts only a command that
// belongs to that same code or to code that is not older, and otherwise refuses with a sentence the owner can read.
// Stdlib only; this module never runs `wam` itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BUNDLE_MARKER = 'wizard-builder-bundle-v1'; // a frozen builder copy of wam (bundle.json "owner"); never a repair tool
const API_UNIT = 'wizard-app-manager-api.service';

const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const isExec = f => { try { return fs.statSync(f).isFile() && (fs.accessSync(f, fs.constants.X_OK), true); } catch { return false; } };
const real = f => { try { return fs.realpathSync(f); } catch { return path.resolve(f); } };
const within = (dir, f) => { const r = path.relative(real(dir), real(f)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// The checkout the running App Manager (its API service) starts from, read from the user unit and its drop-ins
// (the last WorkingDirectory wins, as in systemd). WAM_RUNNING_SOURCE names it explicitly.
export function runningSource(env = process.env, home = os.homedir()) {
  if (env.WAM_RUNNING_SOURCE) return env.WAM_RUNNING_SOURCE;
  const base = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd/user');
  const files = [path.join(base, API_UNIT)];
  try { for (const f of fs.readdirSync(path.join(base, `${API_UNIT}.d`)).filter(n => n.endsWith('.conf')).sort()) files.push(path.join(base, `${API_UNIT}.d`, f)); } catch {}
  let dir = '';
  for (const f of files) for (const line of readText(f).split('\n')) {
    const m = line.match(/^\s*WorkingDirectory=(.*)$/);
    if (m) dir = m[1].trim().replace(/^[-!]+/, '').replace(/^%h(?=\/|$)/, home);
  }
  return dir || '';
}

// The code a `wam` command runs: the directory its launcher `cd`s into (install.sh writes `cd "<checkout>" && exec python -m wam`).
export function launcherSource(bin) {
  const head = readText(bin).slice(0, 4096);
  if (head.includes(BUNDLE_MARKER)) return { bundle: true, dir: '' };
  const m = head.match(/\bcd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;|\n)/);
  return { bundle: false, dir: m ? (m[1] || m[2] || m[3]) : '' };
}

// How new a checkout's code is, in seconds: its git commit time, else the newest wam/*.py file. 0 = cannot tell.
export function stamp(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  try {
    const t = +execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ct'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (t > 0) return t;
  } catch {}
  let newest = 0;
  try { for (const n of fs.readdirSync(path.join(dir, 'wam'))) if (n.endsWith('.py')) newest = Math.max(newest, Math.floor(fs.statSync(path.join(dir, 'wam', n)).mtimeMs / 1000)); } catch {}
  return newest;
}

function candidates(env, home, running) {
  const list = [];
  if (running) list.push({ bin: path.join(running, 'bin/wam'), via: 'the running App Manager' });
  list.push({ bin: path.join(home, '.local/bin/wam'), via: 'the installed command (~/.local/bin/wam)' });
  for (const d of (env.PATH || '').split(path.delimiter).filter(Boolean)) list.push({ bin: path.join(d, 'wam'), via: `wam on PATH (${d})` });
  const seen = new Set();
  return list.filter(c => { const k = real(c.bin); if (seen.has(k) || !isExec(c.bin)) return false; seen.add(k); return true; });
}

// -> { ok, bin, via, reason, running, tried:[{bin, via, verdict}] }. `reason` is plain words and is set when ok is false.
export function resolveWam(env = process.env, home = os.homedir()) {
  if (env.WAM_BIN) {
    const ok = fs.existsSync(env.WAM_BIN);
    return { ok, bin: env.WAM_BIN, via: 'WAM_BIN', running: '', tried: [], ...(ok ? {} : { reason: `The App Manager command set in WAM_BIN (${env.WAM_BIN}) does not exist.` }) };
  }
  const running = runningSource(env, home);
  const want = running ? stamp(running) : 0;
  const tried = [];
  for (const c of candidates(env, home, running)) {
    const src = running && within(running, c.bin) ? { bundle: false, dir: running } : launcherSource(c.bin);
    if (src.bundle) { tried.push({ bin: c.bin, via: c.via, verdict: 'a frozen builder copy' }); continue; }
    if (!running) return { ok: true, bin: c.bin, via: c.via, running: '', tried }; // no running App Manager to compare with
    if (src.dir && real(src.dir) === real(running)) return { ok: true, bin: c.bin, via: c.via, running, tried };
    const have = stamp(src.dir);
    if (want && have >= want) return { ok: true, bin: c.bin, via: c.via, running, tried };
    tried.push({ bin: c.bin, via: c.via, verdict: have ? 'older than the running App Manager' : 'cannot tell which App Manager it runs' });
  }
  if (!tried.length) return { ok: false, bin: '', via: '', running, tried, reason: 'No App Manager command (wam) was found on this box.' };
  const t = tried[0];
  return { ok: false, bin: '', via: '', running, tried, reason: `The App Manager command at ${t.bin} is ${t.verdict}, so the repair was not run: it could undo what the current App Manager published. Update the App Manager (rerun its installer), then the guardian can repair again.` };
}

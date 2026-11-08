#!/usr/bin/env node
// Runs ONE owner-approved repair plan (lib/repair-plan.mjs), normally inside its own transient user unit so it
// outlives restarts of whatever it repairs. Refuses to run without the owner's approval for this exact plan digest.
//   execute-plan.mjs <plan dir>          run the approved plan: back up, apply steps, verify
//   execute-plan.mjs <plan dir> --undo   restore every file the run backed up, then verify again
// Output: run.json / undo.json (machine state) and transcript.log (everything that happened, in order).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { digestOf, normalizePlan, pathRefusal } from '../lib/repair-plan.mjs';
import { CONFIG, logIncident } from '../lib/checks.mjs';

const HOME = os.homedir();
const dir = process.argv[2], undo = process.argv.includes('--undo');
if (!dir || !fs.existsSync(path.join(dir, 'plan.json'))) { console.error('usage: execute-plan.mjs <plan dir> [--undo]'); process.exit(2); }
const J = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
const save = (f, v) => { const t = path.join(dir, `${f}.tmp`); fs.writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(t, path.join(dir, f)); };
const T = path.join(dir, 'transcript.log');
const log = s => fs.appendFileSync(T, `[${new Date().toISOString().slice(11, 19)}Z] ${s}\n`, { mode: 0o600 });
const rec = J('plan.json');
const ENV = { ...process.env, HOME, PATH: `${path.join(HOME, '.local/bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}` };

function sh(command, timeoutS) {
  return new Promise(resolve => {
    const child = spawn('bash', ['-lc', command], { cwd: HOME, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = d => { const s = String(d); out = (out + s).slice(-20000); fs.appendFileSync(T, s.replace(/^/gm, '    ')); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const timer = setTimeout(() => { log(`  timed out after ${timeoutS} s; stopping it`); try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutS * 1000);
    child.on('close', (code, sig) => { clearTimeout(timer); resolve({ code: code ?? (sig ? 137 : 1), out }); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: 127, out: e.message }); });
  });
}
const get = url => new Promise(resolve => {
  const req = http.get(url, { timeout: 8000 }, res => { let b = ''; res.on('data', d => { if (b.length < 4096) b += d; }); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, detail: `HTTP ${res.statusCode}` })); });
  req.on('timeout', () => req.destroy(new Error('no answer in 8 s'))); req.on('error', e => resolve({ ok: false, detail: e.message }));
});
// Standard health after every repair: Hermes, the Agent Service (Wizard's backend) and both units running.
function healthTargets() {
  if (process.env.REPAIR_HEALTH_URLS !== undefined) return String(process.env.REPAIR_HEALTH_URLS).split(',').filter(Boolean).map(s => { const [name, ...u] = s.split('='); return { name, url: u.join('=') }; });
  const t = [];
  if (CONFIG.hermesPort) t.push({ name: 'Hermes', url: `http://127.0.0.1:${CONFIG.hermesPort}/health` });
  if (CONFIG.agentPort) t.push({ name: 'Agent Service', url: `http://127.0.0.1:${CONFIG.agentPort}/wizard/health` });
  for (const [name, unit] of [['Hermes unit', CONFIG.hermesUnit], ['Agent Service unit', CONFIG.agentUnit]]) if (unit) t.push({ name, unit });
  return t;
}
async function health() {
  const targets = healthTargets(), deadline = Date.now() + +(process.env.REPAIR_HEALTH_WAIT_MS || 90000);
  let res;
  for (;;) {
    res = [];
    for (const t of targets) {
      if (t.url) { const r = await get(t.url); res.push({ name: t.name, ok: r.ok, detail: `${t.url} → ${r.detail}` }); continue; }
      let state = ''; try { state = execFileSync('systemctl', ['--user', 'is-active', t.unit], { encoding: 'utf8', timeout: 10000 }).trim(); } catch (e) { state = String(e.stdout || 'inactive').trim(); }
      res.push({ name: t.name, ok: state === 'active', detail: `${t.unit} ${state}` });
    }
    if (res.every(r => r.ok) || Date.now() > deadline) break;
    await new Promise(r => setTimeout(r, 5000)); // services that were just restarted get time to come up
  }
  for (const r of res) log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name}: ${r.detail}`);
  return res;
}

// Files a run step names: every token that is an existing regular file (absolute, ~/ or $HOME/), so a command's
// edits can be undone too. Directories and huge files are not copied.
function fileTokens(cmd) {
  const out = new Set();
  for (const m of cmd.matchAll(/(?:^|[\s"'=:(<>|;&])((?:~|\$HOME|\$\{HOME\})?\/[^\s"'`;&|<>()]+)/g)) {
    const p = m[1].replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, HOME);
    try { const st = fs.statSync(p); if (st.isFile() && st.size <= 20 << 20 && !pathRefusal(p)) out.add(path.resolve(p)); } catch {}
  }
  return [...out];
}
function backupAll(plan) {
  const want = new Set();
  for (const s of plan.steps) {
    if (s.action === 'edit' || s.action === 'write') want.add(s.path);
    else for (const f of fileTokens(s.command)) want.add(f);
  }
  const bdir = path.join(dir, 'backup'); fs.mkdirSync(bdir, { recursive: true, mode: 0o700 });
  return [...want].map((p, i) => {
    const b = { path: p, backup: path.join(bdir, String(i)), existed: false };
    try { const st = fs.statSync(p); if (st.isFile()) { fs.copyFileSync(p, b.backup); fs.chmodSync(b.backup, 0o600); Object.assign(b, { existed: true, mode: st.mode & 0o7777, size: st.size }); } } catch {}
    log(`backup ${p}${b.existed ? ` → ${b.backup}` : ' (does not exist yet; undo removes it)'}`);
    return b;
  });
}
function atomicWrite(p, content) {
  let mode = 0o644; try { mode = fs.statSync(p).mode & 0o7777; } catch { fs.mkdirSync(path.dirname(p), { recursive: true }); }
  const t = `${p}.repair-${process.pid}`;
  fs.writeFileSync(t, content, { mode }); fs.chmodSync(t, mode); fs.renameSync(t, p);
  if (fs.readFileSync(p, 'utf8') !== content) throw new Error('read-back did not match');
}

async function runPlan() {
  const approval = J('approval.json');
  if (!approval || approval.digest !== rec.digest || digestOf(rec.plan) !== rec.digest) { log('REFUSED: no owner approval for this exact plan.'); save('run.json', { state: 'failed', error: 'not approved', finishedAt: new Date().toISOString() }); process.exit(3); }
  try { fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ state: 'running', startedAt: new Date().toISOString(), pid: process.pid }), { mode: 0o600, flag: 'wx' }); }
  catch { console.error('already ran'); process.exit(4); } // never twice
  const plan = rec.plan, run = { state: 'running', startedAt: new Date().toISOString(), pid: process.pid, approvedBy: approval.by, steps: [], verify: [], health: [] };
  log(`Repair plan "${plan.title}" approved by ${approval.by} at ${approval.at}; running as ${os.userInfo().username}.`);
  let failed = '';
  try { normalizePlan(plan); } catch (e) { failed = e.message; log(`REFUSED: ${e.message}`); }
  run.backups = failed ? [] : backupAll(plan); save('run.json', run);
  for (const [i, s] of plan.steps.entries()) {
    if (failed) break;
    const n = i + 1;
    if (s.why) log(`step ${n}: ${s.why}`);
    try {
      if (s.action === 'run') {
        log(`step ${n}: $ ${s.command}`);
        const r = await sh(s.command, s.timeout_s);
        run.steps.push({ step: n, ok: r.code === 0, code: r.code });
        log(`step ${n}: exit ${r.code}`);
        if (r.code !== 0) failed = `step ${n} exited ${r.code}`;
      } else if (s.action === 'edit') {
        const before = fs.readFileSync(s.path, 'utf8'), count = before.split(s.find).length - 1;
        if (count !== 1) throw new Error(`the text to replace appears ${count} times in ${s.path} (needs exactly 1)`);
        atomicWrite(s.path, before.replace(s.find, () => s.replace));
        run.steps.push({ step: n, ok: true }); log(`step ${n}: edited ${s.path} (1 replacement, read back OK)`);
      } else {
        atomicWrite(s.path, s.content);
        run.steps.push({ step: n, ok: true }); log(`step ${n}: wrote ${s.path} (${Buffer.byteLength(s.content)} bytes, read back OK)`);
      }
    } catch (e) { run.steps.push({ step: n, ok: false, error: e.message }); failed = `step ${n}: ${e.message}`; log(`step ${n}: FAILED ${e.message}`); }
    save('run.json', run);
  }
  log(failed ? `Stopped: ${failed}. Checking health anyway.` : 'All steps done. Verifying.');
  for (const [i, c] of plan.verify.entries()) {
    log(`verify ${i + 1}: $ ${c}`);
    const r = await sh(c, 120);
    run.verify.push({ check: i + 1, ok: r.code === 0, code: r.code });
    log(`verify ${i + 1}: exit ${r.code}`);
  }
  run.health = await health();
  const verified = run.verify.every(v => v.ok) && run.health.every(h => h.ok);
  Object.assign(run, { state: !failed && verified ? 'succeeded' : 'failed', error: failed || (verified ? '' : 'verification failed'), verified, finishedAt: new Date().toISOString() });
  log(run.state === 'succeeded' ? 'Repair succeeded and verified.' : `Repair did not verify: ${run.error}. Undo restores the backed-up files.`);
  save('run.json', run);
  logIncident({ kind: 'repair-plan-result', plan: rec.id, ok: run.state === 'succeeded', detail: `${plan.title}: ${run.state}${run.error ? ` (${run.error})` : ''}` });
}

async function undoRun() {
  const run = J('run.json');
  if (!J('undo-request.json') || !run?.backups) { log('Undo refused: not requested by the owner or nothing backed up.'); process.exit(3); }
  try { fs.writeFileSync(path.join(dir, 'undo.json'), JSON.stringify({ state: 'running', startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' }); }
  catch { process.exit(4); }
  const u = { state: 'running', startedAt: new Date().toISOString(), restored: [] };
  log('Undo requested by the owner: restoring backed-up files.');
  for (const b of run.backups) {
    try {
      if (b.existed) { const t = `${b.path}.undo-${process.pid}`; fs.copyFileSync(b.backup, t); fs.chmodSync(t, b.mode ?? 0o644); fs.renameSync(t, b.path); log(`restored ${b.path}`); }
      else if (fs.existsSync(b.path)) { fs.unlinkSync(b.path); log(`removed ${b.path} (it did not exist before)`); }
      u.restored.push({ path: b.path, ok: true });
    } catch (e) { u.restored.push({ path: b.path, ok: false, error: e.message }); log(`could not restore ${b.path}: ${e.message}`); }
  }
  log('Files restored. Commands the plan ran (for example restarts) are not reversed. Checking health.');
  u.health = await health();
  Object.assign(u, { state: 'done', ok: u.restored.every(r => r.ok), finishedAt: new Date().toISOString() });
  save('undo.json', u);
  logIncident({ kind: 'repair-plan-undo-result', plan: rec.id, ok: u.ok, detail: `Undid ${rec.plan.title}` });
}

(undo ? undoRun() : runPlan()).catch(e => { log(`Executor error: ${e.stack || e.message}`); try { const f = undo ? 'undo.json' : 'run.json'; save(f, { ...(J(f) || {}), state: undo ? 'done' : 'failed', ok: false, error: e.message, finishedAt: new Date().toISOString() }); } catch {} process.exit(1); });

#!/usr/bin/env node
// Wizard Guardian: runs every minute (wizard-guardian.timer), independent of the Agent Service and Hermes.
// For each broken link it restarts the piece, undoes a fresh Agent Service update if a restart doesn't help,
// and as a last resort starts a Troubleshooter repair through the box's Claude/ChatGPT/Tinfoil connection apps.
// GUARDIAN_ACT=0 (or --dry-run) makes it report-only.
// Every action is logged to the incident log and reported once in the owner's Wizard thread.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { CONFIG, CHECKS, runChecks, doAction, deployInProgress, lastAgentRelease, logIncident, run } from '../lib/checks.mjs';

const STATE = path.join(CONFIG.stateDir, 'guardian.json');
const TOKEN = path.join(CONFIG.stateDir, 'guardian.token');
const HOUR = 3600e3;
const MAX_FIXES_PER_HOUR = 3;
const ROLLBACK_WINDOW = 2 * HOUR; // undo only an update installed this recently
const AI_REPAIR_GAP = 2 * HOUR;
// GUARDIAN_ACT=0: report-only (checks, counts and logs what it would do, never restarts, rolls back or starts a repair).
const DRY = process.argv.includes('--dry-run') || process.env.GUARDIAN_ACT === '0';
const THREAD = process.env.GUARDIAN_THREAD || '';

const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { fails: {}, fixes: {}, outage: null, lastAiRepair: 0, rolledBack: {} }; } };
const save = s => { fs.writeFileSync(STATE + '.tmp', JSON.stringify(s, null, 1), { mode: 0o600 }); fs.renameSync(STATE + '.tmp', STATE); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function guardianToken() {
  try { return fs.readFileSync(TOKEN, 'utf8').trim(); } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN, t, { mode: 0o600 });
  return t;
}

async function postThread(key, body) {
  if (!THREAD || DRY) return;
  const f = path.join(CONFIG.stateDir, 'post.md');
  fs.writeFileSync(f, body);
  const py = path.join(os.homedir(), '.hermes/hermes-agent/venv/bin/python');
  const r = await run(py, [path.join(os.homedir(), '.hermes/scripts/wizard_thread_post.py'), THREAD, key, f], { timeout: 60000 });
  if (!r.ok) logIncident({ kind: 'report-failed', detail: (r.err || r.out).slice(-300) });
}

function startAiRepair(message) {
  return new Promise(resolve => {
    const body = JSON.stringify({ message, engine: 'auto' });
    const req = http.request({ host: '127.0.0.1', port: +(process.env.TROUBLESHOOT_PORT || 9691), path: '/troubleshoot/api/guardian-repair', method: 'POST', timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'X-Guardian-Token': guardianToken(), 'Content-Length': Buffer.byteLength(body) } }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { resolve(res.statusCode < 300 ? JSON.parse(b) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
    req.end(body);
  });
}

const bare = s => String(s || '').replace(/\.$/, '');
const bkk = d => new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });

async function main() {
  const s = load();
  const now = Date.now();
  if (await deployInProgress()) { console.log('Agent Service update in progress; checking again next minute.'); return; }
  const status = await runChecks();
  const byId = Object.fromEntries(CHECKS.map(c => [c.id, c]));
  const failing = status.checks.filter(c => !c.ok);
  const actionsTaken = [];

  for (const c of status.checks) s.fails[c.id] = c.ok ? 0 : (s.fails[c.id] || 0) + 1;

  // Outage bookkeeping (only core links count as "Wizard is down").
  const core = failing.filter(c => !byId[c.id].noAutoFix);
  if (core.length && !s.outage) {
    s.outage = { since: now, first: core.map(c => `${c.label}: ${c.detail}`) };
    logIncident({ kind: 'outage', text: `Problem found: ${core.map(c => `${c.label} (${bare(c.detail)})`).join('; ')}` });
  }

  for (const c of failing) {
    const def = byId[c.id];
    if (def.noAutoFix || s.fails[c.id] < (def.threshold || 2)) continue;
    const recent = (s.fixes[c.id] || []).filter(t => now - t < HOUR);
    s.fixes[c.id] = recent;
    const release = def.rollback ? await lastAgentRelease() : null;
    const freshUpdate = release && now - release.changedAt < ROLLBACK_WINDOW && s.rolledBack[c.id] !== release.target;
    // Escalation: restart first; if a restart already failed to help and an update is fresh, undo it.
    let action = null;
    if (recent.length >= 1 && freshUpdate) action = `rollback:${c.id}`;
    else if (recent.length < MAX_FIXES_PER_HOUR) action = `restart:${c.id}`;
    if (!action) continue;
    if (DRY) { console.log('[dry-run] would', action, 'for', c.label, '-', c.detail); if (process.env.GUARDIAN_ACT === '0' && s.fails[c.id] === (def.threshold || 2)) logIncident({ kind: 'would-fix', action, text: `Report-only: ${c.label} wasn't working (${bare(c.detail)}); the guardian would ${action.startsWith('rollback') ? 'undo the last update' : 'restart it'}.` }); continue; }
    logIncident({ kind: 'auto-fix', action, text: `${c.label} wasn't working (${bare(c.detail)}). Wizard ${action.startsWith('rollback') ? 'is undoing the last update' : 'is restarting it'}.` });
    const r = await doAction(action);
    recent.push(now);
    if (action.startsWith('rollback') && release) s.rolledBack[c.id] = release.target;
    await sleep(8000);
    const again = (await runChecks()).checks.find(x => x.id === c.id);
    const fixed = r.ok && again?.ok;
    actionsTaken.push({ label: c.label, action, fixed, detail: c.detail, result: r.detail });
    logIncident({ kind: 'auto-fix-result', action, ok: fixed, text: fixed ? `${c.label} is working again.` : `${c.label} is still not working after ${action.startsWith('rollback') ? 'undoing the update' : 'a restart'}.` });
    if (fixed) s.fails[c.id] = 0;
  }

  // Last resort: hand it to the owner's AI subscription with full server access.
  const stuck = failing.filter(c => !byId[c.id].noAutoFix && s.fails[c.id] >= 6 && (s.fixes[c.id] || []).length >= 2);
  if (stuck.length && now - (s.lastAiRepair || 0) > AI_REPAIR_GAP && !DRY) {
    const msg = `Automatic check: Wizard has been broken for ${s.fails[stuck[0].id]} minutes and restarts did not fix it.\n` +
      stuck.map(c => `- ${c.label}: ${c.detail}`).join('\n') + `\nFind the cause, fix it, verify with the status script, and explain what you did in plain words.`;
    const r = await startAiRepair(msg);
    if (r?.id) {
      s.lastAiRepair = now;
      logIncident({ kind: 'repair-started', conversation: r.id, text: `Restarts didn't fix ${stuck.map(c => c.label).join(', ')}. Wizard asked your AI subscription to repair it.` });
      actionsTaken.push({ label: stuck.map(c => c.label).join(', '), action: 'ai-repair', fixed: false, conversation: r.id });
    }
  }

  // Recovery and reporting.
  const stillCore = (await (actionsTaken.length ? runChecks() : Promise.resolve(status))).checks.filter(c => !c.ok && !byId[c.id].noAutoFix);
  if (s.outage && !stillCore.length) {
    const mins = Math.max(1, Math.round((now - s.outage.since) / 60e3));
    logIncident({ kind: 'recovered', text: `Wizard is working again (problem lasted about ${mins} min).` });
    if (s.outage.reported) {
      await postThread(`guardian-recovered-${s.outage.since}`, `**Wizard is working again.** The problem that started at ${bkk(s.outage.since)} (Bangkok) is fixed; it lasted about ${mins} min. Details: /troubleshoot/`);
    }
    s.outage = null;
  }
  if (actionsTaken.length) {
    const lines = actionsTaken.map(a => a.action === 'ai-repair'
      ? `- ${a.label}: restarts didn't fix it, so I've asked your Claude/ChatGPT subscription to repair it. Follow along: /troubleshoot/#r=${a.conversation}`
      : `- ${a.label} stopped working (${bare(a.detail)}). I ${a.action.startsWith('rollback') ? 'undid the last update' : 'restarted it'}: ${a.fixed ? 'it works again.' : 'still not working, trying further steps.'}`);
    if (s.outage) s.outage.reported = true;
    await postThread(`guardian-${now}`, `**Wizard fixed itself** at ${bkk(now)} (Bangkok).\n\n${lines.join('\n')}\n\nAnything still wrong? Open the Troubleshooter: /troubleshoot/`);
  }
  save(s);
  console.log(JSON.stringify({ overall: status.overall, failing: failing.map(f => f.id), actions: actionsTaken.map(a => `${a.action}:${a.fixed}`) }));
}

main().catch(e => { console.error(e); process.exit(1); });

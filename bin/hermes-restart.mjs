#!/usr/bin/env node
// An owner-confirmed Hermes restart with a bounded wait. Runs in its own transient user unit (lib/checks.mjs
// launchRunner), outside the gateway and outside the Troubleshooter, so it finishes whatever happens to either.
//
//   hermes-restart.mjs <out> <drain argv...>   the gateway's own drain restart (`hermes gateway restart --interrupt`),
//                                              then, if no new process came up within HERMES_FORCE_AFTER_S, stop waiting
//   hermes-restart.mjs <out> --force-now       stop waiting now ("Restart your agent now")
//
// 9 Nov 2026: a drain held every new owner message back for ~10 min while it waited (cap 30 min) on 19 work units,
// mostly scheduled tasks. The owner asked for the restart, so other work never holds it for long. Stopping the wait
// is SIGTERM to the gateway's main process: the gateway then does its own bounded shutdown (pausing turns, which
// resume afterwards) and systemd starts a new process. SIGKILL only if it is still the same process
// HERMES_KILL_AFTER_S later. Writes <out>.log as it goes and <out>.exit (0: a new process is running) at the end.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { CONFIG, hermesMainPid, signalHermes, noteRestart } from '../lib/checks.mjs';

const args = process.argv.slice(2);
const out = args.shift();
if (!out) { console.error('usage: hermes-restart.mjs <out> (--force-now | <drain argv...>)'); process.exit(2); }
const forceNow = args[0] === '--force-now';
if (forceNow) args.shift();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = m => fs.appendFileSync(`${out}.log`, `[troubleshooter ${new Date().toISOString()}] ${m}\n`);
const iso = () => new Date().toISOString();

const startPid = await hermesMainPid();
let cliExit = null, child = null;
if (!forceNow && args.length) {
  const fd = fs.openSync(`${out}.log`, 'a');
  child = spawn(args[0], args.slice(1), { cwd: CONFIG.hermesHome, stdio: ['ignore', fd, fd], env: process.env });
  child.on('exit', c => { cliExit = c ?? 1; });
  child.on('error', e => { say(`could not run the drain restart: ${e.message}`); cliExit = 127; });
}
let termAt = forceNow ? Date.now() : Date.now() + CONFIG.hermesForceAfterMs, killAt = 0, deadline = 0, code = 1;
say(forceNow ? `restart now asked for (process ${startPid || 'none'})` : `drain restart started (process ${startPid || 'none'}); it stops waiting after ${CONFIG.hermesForceAfterMs / 1000} s`);
for (;;) {
  const pid = await hermesMainPid();
  if (pid && pid !== startPid) { say(`new process ${pid} (was ${startPid || 'none'})`); code = 0; break; }
  const t = Date.now();
  // The drain command itself failed (refused, crashed, missing): the owner asked for a restart, so restart directly.
  if (!killAt && cliExit !== null && cliExit !== 0 && t < termAt) { say(`the drain restart command ended with exit ${cliExit}; restarting directly`); termAt = t; }
  if (!killAt && t >= termAt) {
    const r = await signalHermes(pid, 'SIGTERM');
    say(`stopped waiting: ${r.detail}`);
    noteRestart({ forcedAt: iso() });
    killAt = Date.now() + (pid ? CONFIG.hermesKillAfterMs : CONFIG.hermesGiveUpMs);
    if (!pid) deadline = killAt;
  } else if (killAt && !deadline && t >= killAt) {
    const r = await signalHermes(pid, 'SIGKILL');
    say(`still the same process after SIGTERM: ${r.detail}`);
    noteRestart({ killedAt: iso() });
    deadline = Date.now() + CONFIG.hermesGiveUpMs;
  } else if (deadline && t >= deadline) { say('no new process came up'); break; }
  await sleep(CONFIG.hermesPollMs);
}
if (child && cliExit === null) { try { child.kill('SIGTERM'); } catch {} }
fs.writeFileSync(`${out}.exit`, `${code}\n`);
process.exit(code);

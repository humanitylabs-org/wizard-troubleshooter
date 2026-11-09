// A locked-out owner must get back in from the Troubleshooter alone (9 Nov 2026, James: "100% self-sufficient";
// he knows to type /restart in Telegram or open a console, other owners won't and shouldn't need to).
// Evidence that day: a graceful restart deferred stop for up to 1800 s because 19 work units (mostly scheduled
// tasks) were running, and for ~10 min every new message was refused (runtime_draining).
// Covered here, hermetically (fake systemctl / systemd-run / journalctl / hermes, throwaway HOME, dummy ports;
// nothing touches a real unit):
//   - an owner-asked restart stops waiting after HERMES_FORCE_AFTER_S: SIGTERM to the gateway's main process via
//     `systemctl --user kill --kill-whom=main` (not a stop job, so the RefuseManualStop fence allows it), SIGKILL
//     only if the same process survives; a failed drain command restarts directly; never `systemctl restart/stop`;
//   - someone else's long drain shows how long it waits and on what, and offers "Restart your agent now";
//   - a crash loop is named as such (another restart can't fix it) and the guardian asks the repair chat instead;
//   - the reply keeper is checked and restartable; the guardian restarts a page that stops answering;
//   - the owner is never sent to Telegram, a console or another tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const APP = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function serve(handler) { const s = http.createServer(handler); await new Promise(r => s.listen(0, '127.0.0.1', r)); return s; }
async function closedPort() { const s = await serve(() => {}); const { port } = s.address(); await new Promise(r => s.close(r)); return port; }

// termLands: SIGTERM to the main process brings up a new one (2222). killLands: only SIGKILL does (3333).
// drainCli: 'hang' (the drain never lands by itself), 'fail' (exits 1 at once).
async function rig({ termLands = true, killLands = true, drainCli = 'hang', hermesUp = true } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'self-suff-'));
  const HOME = path.join(root, 'home'), STATE = path.join(root, 'state'), F = path.join(root, 'fake');
  const BIN = path.join(HOME, '.local/bin'); // on the PATH of the transient units (unitEnv)
  const HH = path.join(HOME, '.hermes'), HBIN = path.join(HH, 'hermes-agent/.hermes/bin');
  for (const d of [HOME, STATE, BIN, F, HBIN]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(F, 'mainpid'), '1111');
  const w = (f, s) => fs.writeFileSync(f, s, { mode: 0o755 });
  w(path.join(BIN, 'systemctl'), `#!/bin/bash
echo "$*" >> ${F}/systemctl.log
if [[ "$*" == *" restart fake-hermes"* || "$*" == *" stop fake-hermes"* ]]; then echo "Operation refused (it is configured to refuse manual start/stop)." >&2; exit 1; fi
if [[ "$2" == kill && "$*" == *--kill-whom=main* ]]; then
  [[ "$*" == *SIGTERM* && -f ${F}/term-lands ]] && echo 2222 > ${F}/mainpid
  [[ "$*" == *SIGKILL* && -f ${F}/kill-lands ]] && echo 3333 > ${F}/mainpid
  exit 0
fi
if [[ "$2" == show && "$3" == fake-hermes.service ]]; then echo "MainPID=$(cat ${F}/mainpid)"; echo "ExecMainStartTimestamp=$(cat ${F}/since 2>/dev/null || echo 'Sun 2026-11-08 14:18:10 UTC')"; exit 0; fi
if [[ "$2" == show ]]; then echo "ActiveState=active"; exit 0; fi
exit 0
`);
  if (termLands) fs.writeFileSync(path.join(F, 'term-lands'), '');
  if (killLands) fs.writeFileSync(path.join(F, 'kill-lands'), '');
  // journalctl: draining / drain log lines for the current process; "Scheduled restart job" lines for crash loops.
  w(path.join(BIN, 'journalctl'), `#!/bin/bash
pid=$(cat ${F}/mainpid)
if [[ "$*" == *runtime_draining* ]]; then [[ -f ${F}/journal-draining && "$*" == *"_PID=$pid"* ]] && echo "WARNING gateway.session_authority: Session x paused: runtime_draining"; exit 0; fi
if [[ "$*" == *"Scheduled restart job"* ]]; then for u in $(cat ${F}/crashing 2>/dev/null); do [[ "$*" == *"-u $u"* ]] && for i in 1 2 3 4 5; do echo "$u: Scheduled restart job, restart counter is at $i."; done; done; exit 0; fi
if [[ "$*" == *"(?i)error"* ]]; then for u in $(cat ${F}/crashing 2>/dev/null); do [[ "$*" == *"-u $u"* ]] && echo "ModuleNotFoundError: No module named 'snowballstemmer'"; done; exit 0; fi
exit 0
`);
  w(path.join(BIN, 'systemd-run'), `#!/bin/bash
printf '%s\\n' "$@" >> ${F}/systemd-run.args
envs=(); cwd=/
while [[ $# -gt 0 ]]; do case "$1" in --setenv=*) envs+=("\${1#--setenv=}");; --working-directory=*) cwd="\${1#--working-directory=}";; --*) ;; *) break;; esac; shift; done
cd "$cwd" && env -i "\${envs[@]}" "$@" </dev/null >/dev/null 2>&1 &
exit 0
`);
  w(path.join(HBIN, 'hermes'), `#!/bin/sh
printf '%s\\n' "$*" >> ${F}/hermes.argv
${drainCli === 'fail' ? 'echo "Gateway restart refused" >&2; exit 1' : `echo '{"pid":1111,"gateway_state":"draining","restart_requested":true,"active_agents":19}' > ${HH}/gateway_state.json; sleep 60`}
`);
  const agent = await serve((req, res) => {
    if (req.url === '/wizard/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', upstream_reachable: true, queue: { active: 1, queued: 0, replies_not_started: 0, replies_not_started_s: 0, replies_given_up_15m: 1 } })); }
    res.writeHead(302, { Location: '/' }); res.end();
  });
  const hermes = await serve((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok","version":"test"}'); });
  const closed = await closedPort();
  const keeperSock = path.join(root, 'keeper.sock');
  const env = { PATH: `${BIN}:${process.env.PATH}`, HOME, TROUBLESHOOT_STATE: STATE, WAS_RELEASE_ROOT: path.join(root, 'releases'), WAS_DEPLOY_BIN: path.join(root, 'no-deploy'),
    AGENT_PORT: String(agent.address().port), AGENT_HEALTH_TIMEOUT_MS: '1000', AGENT_UNIT: 'fake-agent.service',
    HERMES_PORT: String(hermesUp ? hermes.address().port : closed), HERMES_UNIT: 'fake-hermes.service',
    GATEWAY_PORT: String(closed), SHELL_PORT: String(closed), AUTH_PORT: '0', TS_SOCKET: path.join(root, 'no.sock'), DOCKER_BIN: '/bin/false', APP_ADDRESSES: '0',
    RUN_KEEPER_UNIT: 'fake-keeper.service', RUN_KEEPER_SOCKET: keeperSock, TROUBLESHOOT_UNIT: '', REPAIR_HEALTH_URLS: '',
    HERMES_RESTART_CONFIRM_MS: '3000', HERMES_RESTART_WAIT_MS: '6000', HERMES_FORCE_AFTER_S: '2', HERMES_KILL_AFTER_S: '2', HERMES_GIVE_UP_S: '2', HERMES_POLL_MS: '200' };
  const read = f => { try { return fs.readFileSync(path.join(F, f), 'utf8'); } catch { return ''; } };
  return { root, HOME, HH, STATE, F, env, keeperSock, read, close: () => { agent.close(); hermes.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
async function node(script, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: APP, env });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 0, err);
  return JSON.parse(out.trim().split('\n').pop());
}
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200); } return false; }
const fenced = log => log.split('\n').filter(l => / (restart|stop) fake-hermes/.test(l));

test('an owner-asked restart stops waiting after the bound: SIGTERM to the main process, never a fenced restart', async () => {
  const r = await rig({ termLands: true });
  try {
    const { res, warn } = await node(`import { ACTIONS, doAction } from './lib/checks.mjs'; const res = await doAction('restart:hermes'); console.log(JSON.stringify({ res, warn: ACTIONS['restart:hermes'].warn }));`, r.env);
    assert.equal(res.ok, true, res.detail);
    assert.match(warn, /scheduled tasks too/);
    assert.match(r.read('hermes.argv'), /gateway restart --interrupt/, 'the gateway\'s own drain restart runs first');
    assert.ok(await until(() => r.read('systemctl.log').includes('kill --kill-whom=main --signal=SIGTERM fake-hermes.service')), r.read('systemctl.log'));
    assert.ok(await until(() => fs.existsSync(path.join(r.STATE, 'hermes-restart.exit'))));
    assert.equal(fs.readFileSync(path.join(r.STATE, 'hermes-restart.exit'), 'utf8').trim(), '0');
    assert.doesNotMatch(r.read('systemctl.log'), /SIGKILL/, 'no SIGKILL when SIGTERM landed');
    assert.deepEqual(fenced(r.read('systemctl.log')), []);
    const rec = JSON.parse(fs.readFileSync(path.join(r.STATE, 'hermes-restart.json'), 'utf8'));
    assert.ok(rec.forcedAt, 'the record says when it stopped waiting');
    const st = await node(`import { hermesRestartState, restartNote } from './lib/checks.mjs'; const s = await hermesRestartState(); console.log(JSON.stringify({ s, note: restartNote(s) }));`, r.env);
    assert.equal(st.s.state, 'restarted');
    assert.equal(st.s.pid, 2222);
  } finally { r.close(); }
});

test('the same process after SIGTERM gets SIGKILL; a failed drain command restarts directly', async () => {
  const r = await rig({ termLands: false, killLands: true, drainCli: 'fail' });
  try {
    const t0 = Date.now();
    await node(`import { doAction } from './lib/checks.mjs'; console.log(JSON.stringify(await doAction('restart:hermes')));`, r.env);
    assert.ok(await until(() => r.read('systemctl.log').includes('--signal=SIGTERM')), 'a refused drain restart goes straight to the direct restart');
    assert.ok(Date.now() - t0 < 8000, 'without waiting out the bound');
    assert.ok(await until(() => r.read('systemctl.log').includes('--signal=SIGKILL fake-hermes.service')));
    assert.ok(await until(() => fs.existsSync(path.join(r.STATE, 'hermes-restart.exit'))));
    assert.equal(fs.readFileSync(path.join(r.STATE, 'hermes-restart.exit'), 'utf8').trim(), '0');
    assert.match(fs.readFileSync(path.join(r.STATE, 'hermes-restart.log'), 'utf8'), /still the same process after SIGTERM/);
    assert.deepEqual(fenced(r.read('systemctl.log')), []);
  } finally { r.close(); }
});

test('someone else\'s long drain: how long and on what, and "Restart your agent now" (only then)', async () => {
  const r = await rig({ termLands: true });
  try {
    // Idle: no Restart-now action on offer, and it refuses without signalling anything.
    const idle = await node(`import { runChecks, doAction } from './lib/checks.mjs'; const s = await runChecks(); const res = await doAction('force-restart:hermes'); console.log(JSON.stringify({ h: s.checks.find(c => c.id === 'hermes'), res }));`, r.env);
    assert.equal(idle.h.ok, true);
    assert.notEqual(idle.h.fix, 'force-restart:hermes');
    assert.equal(idle.res.ok, false);
    assert.doesNotMatch(r.read('systemctl.log'), /kill/);
    // An update's reload started a drain 5 min ago, waiting on 19 units (mostly scheduled tasks), 1500 s left.
    fs.writeFileSync(path.join(r.F, 'journal-draining'), '');
    const t = Math.floor(Date.now() / 1000);
    // Hermes's log format: server local time, "YYYY-MM-DD HH:MM:SS,mmm".
    const stamp = sec => { const d = new Date(sec * 1000), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())},000`; };
    fs.writeFileSync(path.join(r.F, 'since'), new Date((t - 1800) * 1000).toUTCString());
    fs.mkdirSync(path.join(r.HH, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(r.HH, 'logs/gateway.log'), [
      `${stamp(t - 3600)} INFO gateway.run: SIGUSR1 received (an earlier drain, before this process started)`,
      `${stamp(t - 300)} INFO gateway.run: SIGUSR1 received (systemctl reload / hermes gateway restart): performing a graceful gateway restart`,
      `${stamp(t - 300)} INFO gateway.run: Restart requested with 19 active work unit(s); deferring stop() until they finish (cap=1800s)`,
      `${stamp(t - 10)} INFO gateway.run: Restart deferred: waiting on 19 active work unit(s) (0 wedged and excluded, 0 restart-safe and excluded; 1510s remaining before force drain): [{'kind': 'cron', 'job_id': 'a'}, {'kind': 'cron', 'job_id': 'b'}, {'kind': 'managed', 'pid': 7}]`,
    ].join('\n') + '\n');
    const s = await node(`import { runChecks, ACTIONS } from './lib/checks.mjs'; const s = await runChecks(); console.log(JSON.stringify({ checks: s.checks, label: ACTIONS['force-restart:hermes'].label }));`, r.env);
    const h = s.checks.find(c => c.id === 'hermes');
    assert.equal(h.restarting, true);
    assert.equal(h.fix, 'force-restart:hermes', 'the page offers Restart now while the drain holds messages back');
    assert.match(h.detail, /waiting for 19 jobs to finish first \(2 of them scheduled tasks\), for up to 25 min more/);
    assert.match(h.detail, /tap Restart your agent now/);
    const replies = s.checks.find(c => c.id === 'replies-start');
    if (replies && replies.fix) assert.equal(replies.fix, 'force-restart:hermes', 'not a second drain restart');
    assert.equal(s.label, 'Restart your agent now');
    // The model is told the same, with the action name.
    const tool = await node(`import { callTool } from './lib/toolloop.mjs'; console.log(JSON.stringify(await callTool('check_status', '{}', { engine: 'claude' })));`, r.env);
    assert.match(tool, /\[fix: force-restart:hermes\]/);
    assert.match(tool, /run_fix force-restart:hermes stops the wait now/);
    // A second drain restart is not asked for; Restart now stops the wait.
    const again = await node(`import { doAction } from './lib/checks.mjs'; console.log(JSON.stringify(await doAction('restart:hermes')));`, r.env);
    assert.equal(again.already, true);
    assert.equal(r.read('hermes.argv'), '', 'no second drain');
    const now = await node(`import { doAction } from './lib/checks.mjs'; console.log(JSON.stringify(await doAction('force-restart:hermes')));`, r.env);
    assert.equal(now.ok, true, now.detail);
    assert.ok(await until(() => r.read('systemctl.log').includes('kill --kill-whom=main --signal=SIGTERM fake-hermes.service')));
    assert.ok(await until(() => fs.existsSync(path.join(r.STATE, 'hermes-restart.exit'))));
    assert.deepEqual(fenced(r.read('systemctl.log')), []);
  } finally { r.close(); }
});

test('a crash loop is named (a restart cannot fix it) and the guardian asks the repair chat, not another restart', async () => {
  const r = await rig({ hermesUp: false });
  try {
    fs.writeFileSync(path.join(r.F, 'crashing'), 'fake-hermes.service\n');
    const s = await node(`import { runChecks } from './lib/checks.mjs'; console.log(JSON.stringify((await runChecks()).checks.find(c => c.id === 'hermes')));`, r.env);
    assert.equal(s.ok, false);
    assert.equal(s.crashLoop.restarts, 5);
    assert.match(s.detail, /crashed and restarted 5 times in 15 min, so restarting it again won't fix it/);
    assert.match(s.detail, /snowballstemmer/);
    const g = spawn(process.execPath, [path.join(APP, 'bin/guardian.mjs'), '--dry-run'], { cwd: APP, env: { ...r.env, GUARDIAN_ACT: '1' } });
    let out = ''; g.stdout.on('data', d => { out += d; }); g.stderr.on('data', d => { out += d; });
    await new Promise(res => g.on('close', res));
    assert.match(out, /crash loop, would start a repair chat/);
    assert.doesNotMatch(out, /would restart:hermes/);
  } finally { r.close(); }
});

test('the reply keeper is checked and has a restart; the guardian restarts a page that stopped answering', async () => {
  const r = await rig();
  try {
    let k = await node(`import { runChecks, ACTIONS } from './lib/checks.mjs'; const s = await runChecks(); console.log(JSON.stringify({ c: s.checks.find(c => c.id === 'run-keeper'), a: !!ACTIONS['restart:run-keeper'] }));`, r.env);
    assert.equal(k.c.ok, false); assert.match(k.c.detail, /Not running/); assert.equal(k.a, true);
    const srv = net.createServer(c => c.end()); await new Promise(res => srv.listen(r.keeperSock, res));
    k = await node(`import { runChecks } from './lib/checks.mjs'; console.log(JSON.stringify((await runChecks()).checks.find(c => c.id === 'run-keeper')));`, r.env);
    srv.close();
    assert.equal(k.ok, true);
  } finally { r.close(); }
  process.env.TROUBLESHOOT_STATE = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'self-watch-'));
  const { selfWatchStep } = await import('../bin/guardian.mjs');
  const s = {};
  assert.equal(selfWatchStep(s, false), null, 'one missed minute is not enough');
  assert.equal(selfWatchStep(s, false), 'restart');
  assert.equal(selfWatchStep(s, false), null, 'then every other minute, not every minute');
  assert.equal(selfWatchStep(s, true), null);
  assert.equal(s.selfMiss, 0);
});

test('the owner is never sent to Telegram, a console or another tool', () => {
  const prompt = fs.readFileSync(path.join(APP, 'REPAIR_PROMPT.md'), 'utf8');
  assert.match(prompt, /Never tell them to use Telegram or another\s+chat app, a `\/restart` command, a server console, SSH, a terminal or another AI tool/);
  const page = fs.readFileSync(path.join(APP, 'web/index.html'), 'utf8');
  const shown = page.replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, s => (s.match(/(['"`])(?:(?!\1).)*\1/g) || []).join(' '));
  assert.doesNotMatch(shown, /telegram|\bssh\b|console|terminal|claude cli/i);
  for (const f of ['lib/checks.mjs', 'bin/guardian.mjs', 'lib/toolloop.mjs', 'lib/repair.mjs', 'server.mjs']) {
    const code = fs.readFileSync(path.join(APP, f), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).map(l => l.replace(/\s\/\/ .*$/, ''));
    for (const l of code) { assert.doesNotMatch(l, /telegram|\bssh\b|server console/i, `${f}: ${l.trim()}`); assert.doesNotMatch(l, /(?:^|[\s'"`(])\/restart\b/, `${f}: ${l.trim()}`); }
  }
});

test('the guardian stops a drain someone else started once it has held messages back for the bound', async () => {
  process.env.TROUBLESHOOT_STATE ||= fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'self-watch-'));
  const { drainForceDue, DRAIN_FORCE_MS } = await import('../bin/guardian.mjs');
  const now = Date.now(), stall = { ok: false };
  const rs = { state: 'draining', drainSince: now - DRAIN_FORCE_MS - 1000, ours: false, forcedAt: null };
  assert.equal(DRAIN_FORCE_MS, 10 * 60e3);
  assert.equal(drainForceDue(rs, stall, now), true);
  assert.equal(drainForceDue({ ...rs, drainSince: now - 60e3 }, stall, now), false, 'not before the bound');
  assert.equal(drainForceDue(rs, { ok: true }, now), false, 'not while messages still start');
  assert.equal(drainForceDue(rs, null, now), false);
  assert.equal(drainForceDue({ ...rs, forcedAt: new Date().toISOString() }, stall, now), false, 'not twice');
  assert.equal(drainForceDue({ ...rs, ours: true }, stall, now), false, 'an owner-asked restart bounds itself');
  assert.equal(drainForceDue({ ...rs, state: 'idle' }, stall, now), false);
});

test('the drain log is read from the current process only, latest drain wins, a finished wait is not "waiting"', async () => {
  process.env.TROUBLESHOOT_STATE ||= fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'self-watch-'));
  const { parseDrainLog } = await import('../lib/checks.mjs');
  const at = s => new Date(s).getTime();
  const log = [
    '2026-11-09 08:00:22,065 INFO gateway.run: Restart deferred: waiting on 16 active work unit(s) (0 wedged and excluded, 0 restart-safe and excluded; 1408s remaining before force drain): []',
    '2026-11-09 08:54:33,132 INFO gateway.run: SIGUSR1 received (systemctl reload / hermes gateway restart): performing a graceful gateway restart',
    '2026-11-09 08:54:33,147 INFO gateway.run: Restart requested with 19 active work unit(s); deferring stop() until they finish (cap=1800s) so in-flight turns are not amputated (#77184)',
    "2026-11-09 09:00:03,000 INFO gateway.run: Restart deferred: waiting on 15 active work unit(s) (0 wedged and excluded, 0 restart-safe and excluded; 1410s remaining before force drain): [{'kind': 'cron', 'job_id': 'x'}]",
  ].join('\n');
  const d = parseDrainLog(log, at('2026-11-09T09:00:13'), at('2026-11-09T08:04:00'));
  assert.equal(d.since, at('2026-11-09T08:54:33.132'));
  assert.deepEqual(d.waiting, { count: 15, cron: 1, remainingS: 1400 });
  const done = parseDrainLog(log + '\n2026-11-09 09:04:34,442 INFO gateway.run: Restart deferred wait complete — active work drained; proceeding to stop()', at('2026-11-09T09:05:00'), at('2026-11-09T08:04:00'));
  assert.equal(done.waiting, null);
});

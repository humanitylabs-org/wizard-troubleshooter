// Wizard Troubleshooter: health checks and one-tap fixes for every link between the
// user's device and their agent. Shared by the HTTP service and the guardian timer.
// Deliberately stdlib-only and independent of the Agent Service, Hermes and the shell.
// Host layout is configuration: every unit, container, port and front door can be set (or switched off with an
// empty value) so the same code runs on a Caddy box and on a Tailscale Serve box.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { agentReply } from './agent-reply.mjs';
import { inspect as inspectAddresses, launcherFiles, loadRemembered, saveRemembered } from './launchers.mjs';

const HOME = os.homedir();
const env = (k, d) => (process.env[k] === undefined ? d : process.env[k]); // set-but-empty switches a piece off
export const CONFIG = {
  tailscaleSocket: process.env.TS_SOCKET || `/run/user/${process.getuid()}/tailscale-private-gateway.sock`,
  tailscaleUnit: env('TAILSCALE_UNIT', 'tailscale-private-gateway.service'),
  // caddy: Caddy with the PROXY protocol on GATEWAY_PORT (127.0.0.1). tailscale-serve: Tailscale Serve HTTPS on the
  // tailnet address; GATEWAY_PORT is the HTTPS port the shell is served on (for example 443 or 8444).
  gatewayMode: process.env.GATEWAY_MODE || 'caddy',
  gatewayPort: +(process.env.GATEWAY_PORT || 19445),
  gatewayHost: process.env.GATEWAY_HOST || '',
  gatewayUnit: env('GATEWAY_UNIT', 'private-gateway-https.service'),
  // Synthetic reply probes (a real "Reply with just OK" through the agent every ~10 min, and to each repair engine)
  // cost tokens around the clock and can mark Wizard down on their own. Off unless the owner sets this to 1.
  replyProbes: env('TROUBLESHOOTER_REPLY_PROBES', '') === '1',
  authPort: +env('AUTH_PORT', '19447'), // 0 or empty: this box has no separate device sign-in service
  authUnit: env('AUTH_UNIT', 'private-tailnet-auth.service'),
  shellPort: +(process.env.SHELL_PORT || 8928),
  shellPath: process.env.SHELL_PATH || '/wizard-os-home/',
  shellContainer: env('SHELL_CONTAINER', 'wizard-interface-candidate'),
  agentPort: +(process.env.AGENT_PORT || 8923),
  agentHealthTimeoutMs: +(process.env.AGENT_HEALTH_TIMEOUT_MS || 15000),
  // A reply Hermes accepted that has not started for this long, while nothing else holds its thread, is an incident.
  replyStartLimitS: +(process.env.REPLY_START_LIMIT_S || 75),
  agentUnit: env('AGENT_UNIT', 'wizard-mobile.service'),
  agentContainer: env('AGENT_CONTAINER', ''), // when set, the Agent Service is restarted as this container
  // HERMES_PORT=0: Hermes has no host port (a fresh box runs it as the hermes-agent app container); its health is
  // then read from the Agent Service's view of it (/wizard/health upstream_reachable).
  hermesPort: +env('HERMES_PORT', '8642'),
  hermesUnit: env('HERMES_UNIT', 'hermes-gateway.service'),
  hermesContainer: env('HERMES_CONTAINER', ''), // when set (and no unit), Hermes is restarted as this container
  // Hermes's own home and CLI. When the CLI exists, restart:hermes is the gateway's drain restart
  // (`hermes gateway restart --interrupt`, run from outside the gateway), never a raw `systemctl restart`: boxes fence
  // the unit with RefuseManualStop=yes so live work is drained first (9 Nov 2026).
  hermesHome: process.env.HERMES_HOME || path.join(HOME, '.hermes'),
  hermesBin: process.env.HERMES_BIN || path.join(process.env.HERMES_HOME || path.join(HOME, '.hermes'), 'hermes-agent/.hermes/bin/hermes'),
  hermesRestartConfirmMs: +(process.env.HERMES_RESTART_CONFIRM_MS || 20000), // how long a fix waits to see the drain begin
  hermesRestartWaitMs: +(process.env.HERMES_RESTART_WAIT_MS || 60000), // how long the repair chat waits for it to land
  hermesRestartWindowMs: +(process.env.HERMES_RESTART_WINDOW_MS || 20 * 60e3), // a restart asked for longer ago is history
  // Bounded escalation of a restart the owner asked for (9 Nov 2026: a drain waited on 19 work units, mostly
  // scheduled tasks, with a 30 min cap while every new message was refused). After this long without a new
  // process the restart stops waiting: SIGTERM to the gateway's main process, which then does its own bounded
  // shutdown (restart_drain_timeout) and systemd starts it again. SIGKILL only if it is still the same process
  // HERMES_KILL_AFTER_S after that.
  hermesForceAfterMs: +(process.env.HERMES_FORCE_AFTER_S || 180) * 1000,
  hermesKillAfterMs: +(process.env.HERMES_KILL_AFTER_S || 240) * 1000,
  hermesGiveUpMs: +(process.env.HERMES_GIVE_UP_S || 120) * 1000, // after the SIGKILL, how long to wait for a new process
  hermesPollMs: +(process.env.HERMES_POLL_MS || 2000),
  // A unit systemd restarted this many times in 15 min is crash-looping: another restart cannot fix it.
  crashLoopRestarts: +(process.env.CRASH_LOOP_RESTARTS || 3),
  runKeeperUnit: env('RUN_KEEPER_UNIT', 'wizard-run-keeper.service'),
  runKeeperSocket: process.env.RUN_KEEPER_SOCKET || path.join(process.env.HERMES_HOME || path.join(HOME, '.hermes'), 'state/wizard-mobile/run-stream-keeper.sock'),
  publicName: process.env.WIZARD_PUBLIC_NAME || '',
  releaseRoot: process.env.WAS_RELEASE_ROOT || path.join(HOME, '.local/share/wizard-mobile-server'),
  deployBin: process.env.WAS_DEPLOY_BIN || path.join(HOME, '.local/bin/wizard-agent-service-deploy'),
  wam: process.env.WAM_BIN || path.join(HOME, '.local/bin/wam'),
  docker: process.env.DOCKER_BIN || 'docker',
  stateDir: process.env.TROUBLESHOOT_STATE || path.join(HOME, '.local/state/wizard-troubleshooter'),
  // App addresses (lib/launchers.mjs): APP_ADDRESSES=0 switches the check off; GUARDIAN_HEAL_ADDRESSES=0 keeps the
  // guardian from repairing them on its own while GUARDIAN_ACT=0 (report-only) is set.
  appAddresses: env('APP_ADDRESSES', '1') !== '0',
  healAddressesInReportOnly: env('GUARDIAN_HEAL_ADDRESSES', '1') !== '0',
};
fs.mkdirSync(CONFIG.stateDir, { recursive: true, mode: 0o700 });
// The per-box repair policy. A box without one (every fresh install) uses this path, and a missing file means the
// defaults a lockout needs: owner-approved repair plans on, no standing file or command grants (lib/repair-plan.mjs).
export const DEFAULT_POLICY_FILE = path.join(HOME, '.config/wizard-troubleshooter/repair-policy.json');
export const policyFile = () => process.env.REPAIR_POLICY_FILE || DEFAULT_POLICY_FILE;

export function run(cmd, args, { timeout = 60000, env: e, cwd } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, cwd, env: e || process.env, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(stdout || '').trim(), err: String(stderr || '').trim() || (err && !stdout ? String(err.message) : '') });
    });
  });
}

function httpGet({ port, path: p, socketPath, timeout = 5000, headers = {} }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: p, socketPath, timeout, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { if (body.length < 65536) body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - t0 }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer in ${Math.round(timeout / 1000)} s`)));
    req.on('error', e => resolve({ status: 0, error: e.code === 'ECONNREFUSED' ? 'not running' : e.message, ms: Date.now() - t0 }));
  });
}

function tcp(port, timeout = 3000, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// Full trip through the HTTPS front door exactly as a device arrives (TLS with the real name, then a request).
// Caddy mode adds the PROXY header the private gateway expects; Tailscale Serve mode dials the tailnet address.
function frontDoorTrip({ host, port, proxyHeader }, timeout = 6000) {
  return new Promise(resolve => {
    const raw = net.connect({ host, port });
    let done = false, sock;
    const finish = v => { if (done) return; done = true; clearTimeout(timer); try { sock?.destroy(); raw.destroy(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish({ ok: false, detail: 'Accepted the connection but did not answer.' }), timeout);
    raw.on('error', e => finish({ ok: false, detail: `Connection error: ${e.message}.` }));
    raw.on('connect', () => {
      if (proxyHeader) raw.write('PROXY TCP4 127.0.0.1 127.0.0.1 40000 443\r\n');
      sock = tls.connect({ socket: raw, servername: CONFIG.publicName }, () => {
        const cert = sock.getPeerCertificate();
        const days = cert?.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 864e5) : -1;
        if (!sock.authorized) return finish({ ok: false, detail: `Security certificate problem: ${sock.authorizationError}.` });
        sock.write(`GET /troubleshoot/api/ping HTTP/1.1\r\nHost: ${CONFIG.publicName}${proxyHeader || port === 443 ? '' : ':' + port}\r\nConnection: close\r\n\r\n`);
        let buf = '';
        sock.on('data', d => { buf += d; });
        sock.on('end', () => { const code = +(buf.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] || 0); finish(code === 200 ? { ok: true, days } : { ok: false, detail: `Answered with an error (${code || 'no status'}).` }); });
      });
      sock.on('error', e => finish({ ok: false, detail: `Secure connection failed: ${e.message}.` }));
    });
  });
}

const notAnswering = r => r.error === 'not running' ? 'Not running.' : `Not answering: ${r.error}.`;
const bare = s => String(s || '').replace(/\.$/, '');
const waited = s => (s >= 120 ? `${Math.round(s / 60)} min` : `${Math.max(0, Math.round(s || 0))} s`);
// The Agent Service's front page answers without touching the queue or Hermes: any HTTP answer means it is alive.
const agentAnswers = async () => (await httpGet({ port: CONFIG.agentPort, path: '/', timeout: 3000 })).status > 0;
const json = s => { try { return JSON.parse(s); } catch { return null; } };
const readJsonFile = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- transient user units ----------
// Work that must outlive this service (an approved repair plan, a Hermes drain restart) runs in its own transient
// user unit. A transient unit inherits NOTHING from this service: every setting it needs goes in with --setenv.
// 9 Nov 2026: an approved plan refused to run as "switched off" because its unit never saw REPAIR_POLICY_FILE.
// Settings only: never a token (REPAIR_BRIDGE_TOKEN, API keys and sign-in files stay out of every unit).
export const UNIT_ENV_KEYS = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'TS_SOCKET',
  'REPAIR_POLICY_FILE', 'REPAIR_PROTECT', 'REPAIR_HEALTH_URLS', 'REPAIR_HEALTH_WAIT_MS', 'REPAIR_VERIFY_WAIT_MS', 'REPAIR_PLAN_TTL_MS', 'REPAIR_STANDBY_LOCK',
  'HERMES_PORT', 'HERMES_UNIT', 'HERMES_CONTAINER', 'HERMES_HOME', 'HERMES_BIN', 'HERMES_GATEWAY_LOG',
  'HERMES_FORCE_AFTER_S', 'HERMES_KILL_AFTER_S', 'HERMES_GIVE_UP_S', 'HERMES_POLL_MS', 'HERMES_RESTART_WINDOW_MS', 'RUN_KEEPER_UNIT', 'RUN_KEEPER_SOCKET', 'AGENT_PORT', 'AGENT_UNIT', 'AGENT_CONTAINER', 'AGENT_HEALTH_TIMEOUT_MS',
  'SHELL_PORT', 'SHELL_PATH', 'SHELL_CONTAINER', 'GATEWAY_PORT', 'GATEWAY_MODE', 'GATEWAY_HOST', 'GATEWAY_UNIT', 'AUTH_PORT', 'AUTH_UNIT', 'TAILSCALE_UNIT',
  'WIZARD_APP_DATA', 'WAS_RELEASE_ROOT', 'WAS_DEPLOY_BIN', 'WAM_BIN', 'DOCKER_BIN'];
export function unitEnv(extra = {}) {
  return { PATH: `${path.join(HOME, '.local/bin')}:/usr/local/bin:/usr/bin:/bin`, HOME, TROUBLESHOOT_STATE: CONFIG.stateDir,
    ...Object.fromEntries(UNIT_ENV_KEYS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])), ...extra };
}
export function launchUnit({ unit, description, argv, cwd = HOME, env = unitEnv() }) {
  try {
    execFileSync('systemd-run', ['--user', '--collect', `--unit=${unit}`, `--description=${description}`, `--working-directory=${cwd}`,
      ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), ...argv], { timeout: 15000, stdio: 'ignore' });
    return { via: 'systemd-run', unit };
  } catch {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: 'ignore' });
    child.unref();
    return { via: 'detached', pid: child.pid };
  }
}

// ---------- Hermes drain restarts ----------
// `hermes gateway restart` drains first: the gateway refuses new turns, finishes or pauses the ones running, then
// exits and systemd starts a new process. That takes minutes, and until it lands the PID and start time are the
// SAME. 9 Nov 2026: the repair chat read an unchanged PID as "it didn't actually restart" while the drain was
// running; the new gateway came up 90 s later. Evidence of a drain: Hermes's own gateway_state.json
// (gateway_state "draining" / restart_requested), the journal's `runtime_draining` from the current process, or a
// restart this service asked for that hasn't landed yet.
const HERMES_RESTART = path.join(CONFIG.stateDir, 'hermes-restart.json');
const restartOut = path.join(CONFIG.stateDir, 'hermes-restart');
async function unitProps(unit, props) {
  const r = await run('systemctl', ['--user', 'show', unit, ...props.flatMap(p => ['-p', p])], { timeout: 10000 });
  return Object.fromEntries(r.out.split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]).filter(([k]) => k));
}
const hhmm = t => { const d = new Date(t); return isNaN(d) ? String(t || '?') : `${d.toISOString().slice(11, 16)} UTC`; };
const inMin = s => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s || 0))} s`);
const readRestart = () => readJsonFile(HERMES_RESTART);
// Merge into the restart record (the runner adds forcedAt/killedAt as it escalates).
export function noteRestart(patch) {
  const rec = readRestart() || {};
  fs.writeFileSync(HERMES_RESTART + '.tmp', JSON.stringify({ ...rec, ...patch }), { mode: 0o600 });
  fs.renameSync(HERMES_RESTART + '.tmp', HERMES_RESTART);
}
export async function hermesMainPid() {
  return CONFIG.hermesUnit ? +(await unitProps(CONFIG.hermesUnit, ['MainPID'])).MainPID || 0 : 0;
}
// The gateway's own log (Hermes writes these INFO lines to $HERMES_HOME/logs/gateway.log, not the journal) says how
// long it has been draining and what it waits for:
//   "SIGUSR1 received ..." / "Restart requested with 19 active work unit(s); deferring stop() ... (cap=1800s)"
//   "Restart deferred: waiting on 15 active work unit(s) (...; 1259s remaining before force drain): [{'kind': 'cron', ...}]"
// Lines start "YYYY-MM-DD HH:MM:SS,mmm" (server local time) or, from journalctl -o short-unix, epoch seconds. Only
// lines from notBefore on (the current process's start) count; the latest drain start wins.
// Returns { since, waiting: { count, cron, remainingS } }.
const lineTime = line => {
  const u = line.match(/^(\d{9,})(?:\.\d+)?\s/);
  if (u) return +u[1] * 1000;
  const d = line.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:,(\d{3}))?\s/);
  return d ? new Date(`${d[1]}T${d[2]}.${d[3] || '000'}`).getTime() : 0;
};
export function parseDrainLog(text, now = Date.now(), notBefore = 0) {
  let since = null, waiting = null;
  for (const line of String(text || '').split('\n')) {
    const t = lineTime(line);
    if (!t || t < notBefore) continue;
    if (/SIGUSR1 received|Restart requested with/.test(line) && (!since || t - since > 60e3)) { since = t; waiting = null; }
    if (/Restart deferred wait complete/.test(line)) waiting = null;
    let m = line.match(/Restart requested with (\d+) active work unit\(s\)[^\n]*?cap=(\d+)s/);
    if (m) waiting = { count: +m[1], cron: 0, remainingS: +m[2] - (now - t) / 1000 };
    m = line.match(/Restart deferred: waiting on (\d+) active work unit\(s\)[^\n]*?(\d+)s remaining/);
    if (m) waiting = { count: +m[1], cron: (line.match(/'kind': 'cron'/g) || []).length, remainingS: +m[2] - (now - t) / 1000 };
  }
  if (waiting) waiting.remainingS = Math.max(0, Math.round(waiting.remainingS));
  return { since, waiting };
}
function gatewayLogTail(bytes = 768 * 1024) {
  const f = process.env.HERMES_GATEWAY_LOG || path.join(CONFIG.hermesHome, 'logs/gateway.log');
  try {
    const fd = fs.openSync(f, 'r');
    try { const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - n); return b.toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch { return ''; }
}
export async function hermesRestartState() {
  if (!CONFIG.hermesUnit) return { state: 'idle' };
  const p = await unitProps(CONFIG.hermesUnit, ['MainPID', 'ExecMainStartTimestamp']);
  const pid = +p.MainPID || 0, since = p.ExecMainStartTimestamp || '';
  let rec = readRestart();
  if (rec && !(Date.now() - Date.parse(rec.requestedAt) < CONFIG.hermesRestartWindowMs)) rec = null;
  const rt = readJsonFile(path.join(CONFIG.hermesHome, 'gateway_state.json'));
  const rtLive = rt && (!rt.updated_at || Date.now() - Date.parse(rt.updated_at) < 10 * 60e3) && (!pid || !rt.pid || +rt.pid === pid);
  let evidence = rtLive && (rt.gateway_state === 'draining' || rt.restart_requested === true) ? 'gateway state file says draining' : '';
  if (!evidence && pid) {
    const j = await run('journalctl', ['--user', '-u', CONFIG.hermesUnit, `_PID=${pid}`, '--since', '-3min', '--no-pager', '-o', 'cat', '-g', 'runtime_draining', '-n', '1'], { timeout: 10000 });
    if (j.ok && /runtime_draining/.test(j.out)) evidence = 'its log says runtime_draining';
  }
  const base = { pid, since, requestedAt: rec?.requestedAt || null, activeAgents: rtLive ? rt.active_agents : undefined, evidence, previousPid: rec?.previousPid || null,
    ours: !!rec && !rec.external, forcedAt: rec?.forcedAt || null, killedAt: rec?.killedAt || null };
  if (rec && rec.previousPid && pid && pid !== rec.previousPid) return { ...base, state: 'restarted' };
  const drain = async st => {
    const d = pid ? parseDrainLog(gatewayLogTail(), Date.now(), Date.parse(since) || 0) : {};
    return { ...base, ...st, drainSince: rec?.requestedAt ? Date.parse(rec.requestedAt) : d.since || null, waiting: d.waiting || null };
  };
  if (evidence) return drain({ state: 'draining' });
  if (rec) {
    const code = fs.existsSync(`${restartOut}.exit`) ? String(fs.readFileSync(`${restartOut}.exit`, 'utf8')).trim() : null;
    if (code === null) {
      // The command is still running unless its unit (or detached process) is gone without leaving an exit code.
      const alive = rec.via === 'detached' ? (() => { try { process.kill(rec.runner, 0); return true; } catch (e) { return e.code === 'EPERM'; } })()
        : rec.via === 'systemd-run' ? ['active', 'activating', 'deactivating'].includes((await unitProps(rec.unit, ['ActiveState'])).ActiveState) : true;
      return alive ? drain({ state: 'requested' }) : { ...base, state: 'failed', error: 'the restart command stopped before it finished' };
    }
    if (!pid) return drain({ state: 'requested' }); // stopped, systemd is starting the new process
    let out = ''; try { out = fs.readFileSync(`${restartOut}.log`, 'utf8').trim().split('\n').slice(-6).join(' ').slice(-400); } catch {}
    return { ...base, state: 'failed', error: `the restart command ended (exit ${code}) and Hermes kept the same process${out ? `: ${out}` : ''}` };
  }
  return { ...base, state: 'idle' };
}
export const restartInProgress = st => st?.state === 'draining' || st?.state === 'requested';
// What the drain waits for, and when the wait ends. An owner-asked restart never waits on other work for long
// (scheduled tasks included): it stops waiting after HERMES_FORCE_AFTER_S. Someone else's drain (an update, a
// reload) is the owner's call: "Restart now".
function drainDetail(st, model) {
  const parts = [];
  const w = st.waiting;
  if (w?.count) parts.push(` It is waiting for ${w.count} ${w.count === 1 ? 'job' : 'jobs'} to finish first${w.cron ? ` (${w.cron} of them scheduled tasks)` : ''}${w.remainingS > 0 ? `, for up to ${inMin(w.remainingS)} more` : ''}.`);
  if (st.killedAt) parts.push(` It did not stop when asked, so Wizard ended it at ${hhmm(st.killedAt)}; it starts again by itself.`);
  else if (st.forcedAt) parts.push(` Wizard told it to stop waiting at ${hhmm(st.forcedAt)}: it pauses that work (it resumes after the restart) and comes back by itself within a few minutes.`);
  else if (st.ours && st.requestedAt) parts.push(` You asked for this restart, so it does not wait on that work for long: if it hasn't restarted by ${hhmm(Date.parse(st.requestedAt) + CONFIG.hermesForceAfterMs)}, Wizard pauses the work and restarts it anyway.`);
  else if (ACTIONS['force-restart:hermes']) parts.push(model ? ' If the owner cannot wait, run_fix force-restart:hermes stops the wait now (that work is paused and resumes after the restart); the owner confirms it.' : ' If you can\'t wait, tap Restart your agent now.');
  return parts.join('');
}
// Plain words for the page; `model` adds what the repair chat must not misread.
export function restartNote(st, { model = false } = {}) {
  const n = +st.activeAgents > 0 ? ` (${st.activeAgents} still running)` : '';
  if (st.state === 'draining') return `Restart in progress: your agent (Hermes) is draining, finishing or pausing the replies it is working on${n}, then it restarts by itself. This usually takes a few minutes; messages wait and send afterwards.${drainDetail(st, model)}${model ? ` Evidence: ${st.evidence}. Until the drain lands, the PID (${st.pid || '?'}) and start time (${st.since || '?'}) stay the same: that is expected and is NOT a failed restart. Do not restart it again; check_status again in a minute or two.` : ''}`;
  if (st.state === 'requested') return `Restart in progress: a restart of your agent (Hermes) was asked for at ${hhmm(st.requestedAt)} and is starting its drain. Messages wait and send afterwards.${drainDetail(st, model)}${model ? ` Until it lands, the PID (${st.pid || 'none right now'}) and start time stay the same: that is expected and is NOT a failed restart. Do not restart it again; check_status again in a minute or two.` : ''}`;
  if (st.state === 'restarted') return `Your agent (Hermes) restarted at ${hhmm(st.since)}.${model ? ` New PID ${st.pid} (was ${st.previousPid}).` : ''}`;
  if (st.state === 'failed') return `The restart of your agent (Hermes) asked for at ${hhmm(st.requestedAt)} did not happen: ${st.error}.`;
  return '';
}
// Stop the gateway's main process so systemd (Restart=always) starts a new one. `systemctl kill` is not a stop
// job, so the RefuseManualStop fence does not refuse it, and --kill-whom=main leaves restart-safe cron workers in
// the unit alone. On SIGTERM the gateway runs its own bounded shutdown (it pauses turns, which resume afterwards).
// Not running at all: start it.
export async function signalHermes(pid, signal) {
  if (!CONFIG.hermesUnit) return { ok: false, detail: 'Hermes is not a user unit on this box.' };
  if (!pid) {
    await run('systemctl', ['--user', 'reset-failed', CONFIG.hermesUnit], { timeout: 15000 });
    const r = await run('systemctl', ['--user', 'start', CONFIG.hermesUnit], { timeout: 90000 });
    return { ok: r.ok, detail: r.ok ? 'started' : (r.err || r.out).slice(-300) };
  }
  const r = await run('systemctl', ['--user', 'kill', '--kill-whom=main', `--signal=${signal}`, CONFIG.hermesUnit], { timeout: 15000 });
  if (r.ok) return { ok: true, detail: `${signal} sent` };
  try { process.kill(pid, signal); return { ok: true, detail: `${signal} sent to ${pid}` }; } catch (e) { return { ok: false, detail: `${(r.err || r.out).slice(-200)}; ${e.message}` }; }
}
const RUNNER = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'hermes-restart.mjs');
function launchRunner(unit, description, args) {
  const env = unitEnv({ HERMES_HOME: CONFIG.hermesHome, ...(CONFIG.hermesUnit ? { HERMES_UNIT: CONFIG.hermesUnit } : {}) });
  return launchUnit({ unit, description, argv: [process.execPath, RUNNER, restartOut, ...args], cwd: CONFIG.hermesHome, env });
}
async function confirmRestart(a, how, done) {
  const until = Date.now() + CONFIG.hermesRestartConfirmMs;
  let st;
  for (;;) { st = await hermesRestartState(); if (done(st) || Date.now() >= until) break; await sleep(1000); }
  if (st.state === 'failed') return { ok: false, restart: st, via: how.via, detail: `${a.label} failed: ${st.error}` };
  if (st.state === 'restarted') return { ok: true, restart: st, via: how.via, detail: `${a.label}: done. ${restartNote(st)}` };
  return { ok: true, pending: true, restart: st, via: how.via, detail: `${a.label}: started. ${restartNote(st)}` };
}
async function drainRestartHermes(a) {
  const now = await hermesRestartState();
  if (restartInProgress(now)) return { ok: true, pending: true, already: true, restart: now, detail: `${a.label}: not asked twice. ${restartNote(now)}` };
  for (const f of [`${restartOut}.exit`, `${restartOut}.log`]) fs.rmSync(f, { force: true });
  const requestedAt = new Date().toISOString(), unit = `wizard-hermes-restart-${Date.now().toString(36)}`;
  fs.writeFileSync(HERMES_RESTART, JSON.stringify({ requestedAt, previousPid: now.pid || null, previousSince: now.since || null, unit }), { mode: 0o600 });
  // Its own unit, outside the gateway (the CLI refuses to restart the gateway from inside it) and outside this
  // service, so the restart (and its bounded escalation, bin/hermes-restart.mjs) carries on whatever happens here.
  const how = launchRunner(unit, 'Wizard owner-confirmed Hermes restart', a.drain);
  noteRestart({ via: how.via, ...(how.pid ? { runner: how.pid } : {}) });
  return confirmRestart(a, how, st => st.state !== 'requested');
}
// "Restart now": stop waiting for a drain that is holding every new message back.
async function forceRestartHermes(a) {
  const now = await hermesRestartState();
  if (!restartInProgress(now)) return { ok: false, detail: `${a.label}: not needed, your agent (Hermes) is not restarting right now. Use ${ACTIONS['restart:hermes']?.label || 'Restart your agent (Hermes)'} instead.` };
  if (now.forcedAt) return { ok: true, pending: true, already: true, restart: now, detail: `${a.label}: already under way. ${restartNote(now)}` };
  const rec = readRestart();
  const fresh = rec && Date.now() - Date.parse(rec.requestedAt) < CONFIG.hermesRestartWindowMs;
  const unit = `wizard-hermes-force-${Date.now().toString(36)}`;
  if (!fresh) fs.writeFileSync(HERMES_RESTART, JSON.stringify({ requestedAt: new Date(now.drainSince || Date.now()).toISOString(), previousPid: now.pid || null, previousSince: now.since || null, external: true, unit }), { mode: 0o600 });
  noteRestart({ forceAskedAt: new Date().toISOString() });
  fs.rmSync(`${restartOut}.exit`, { force: true });
  const how = launchRunner(unit, 'Wizard owner-confirmed Hermes restart now', ['--force-now']);
  if (!fresh) noteRestart({ via: how.via, unit, ...(how.pid ? { runner: how.pid } : {}) });
  return confirmRestart(a, how, st => !!st.forcedAt || st.state === 'restarted' || st.state === 'failed');
}
// The repair chat re-checks after a drain lands instead of reporting the drain as a failure.
export async function waitForHermesRestart(ms = CONFIG.hermesRestartWaitMs) {
  const until = Date.now() + ms;
  let st;
  for (;;) { st = await hermesRestartState(); if (!restartInProgress(st) || Date.now() >= until) return st; await sleep(Math.min(5000, Math.max(200, until - Date.now()))); }
}

async function tailnetAddress() {
  if (CONFIG.gatewayHost) return CONFIG.gatewayHost;
  const r = await httpGet({ socketPath: CONFIG.tailscaleSocket, path: '/localapi/v0/status', headers: { Host: 'local-tailscaled.sock' }, timeout: 4000 });
  return json(r.body)?.Self?.TailscaleIPs?.find(ip => net.isIP(ip) === 4) || '';
}

// Crash loop: systemd restarted the unit again and again in the last 15 min. Another restart cannot fix that; the
// owner (and the repair chat) need the cause, so the detail says so and carries the last error line.
export async function crashLoop(unit) {
  if (!unit) return null;
  const j = await run('journalctl', ['--user', '-u', unit, '--since', '-15min', '--no-pager', '-o', 'cat', '-g', 'Scheduled restart job'], { timeout: 10000 });
  const restarts = (j.out.match(/Scheduled restart job/g) || []).length;
  if (restarts < CONFIG.crashLoopRestarts) return null;
  const e = await run('journalctl', ['--user', '-u', unit, '--since', '-15min', '--no-pager', '-o', 'cat', '-g', '(?i)error|exception|traceback|exited', '-n', '4'], { timeout: 10000 });
  const lastError = e.out.split('\n').map(l => l.trim()).filter(l => l && !/^Traceback/.test(l)).pop() || '';
  return { restarts, lastError: lastError.slice(0, 240) };
}
async function withCrashLoop(unit, r) {
  const loop = await crashLoop(unit);
  if (!loop) return r;
  return { ...r, crashLoop: loop, detail: `${r.detail} It has crashed and restarted ${loop.restarts} times in 15 min, so restarting it again won't fix it; the repair chat can find the cause.${loop.lastError ? ` Last error: ${loop.lastError}` : ''}` };
}

// Each check: id, label (plain words), what it means for the user, how to fix it.
const ALL_CHECKS = [
  {
    id: 'tailscale', label: 'Private network (Tailscale)', unit: CONFIG.tailscaleUnit, threshold: 2,
    explain: 'Your devices reach Wizard over a private Tailscale network. If this is down, no device can connect.',
    async probe() {
      const r = await httpGet({ socketPath: CONFIG.tailscaleSocket, path: '/localapi/v0/status', headers: { Host: 'local-tailscaled.sock' }, timeout: 4000 });
      if (!r.status) return { ok: false, detail: `Server side of Tailscale isn't running (${r.error}).` };
      const st = json(r.body);
      const state = st?.BackendState;
      return state === 'Running' ? { ok: true, detail: `Connected as ${(st.Self?.DNSName || '').replace(/\.$/, '') || 'Wizard'}.` }
        : { ok: false, detail: `Server's Tailscale is ${state || 'in an unknown state'}${state === 'NeedsLogin' ? ': it needs to be signed in again' : ''}.` };
    },
  },
  {
    id: 'gateway', label: 'Secure gateway', unit: CONFIG.gatewayUnit, threshold: 2,
    explain: 'The HTTPS front door that routes every Wizard page and app.',
    async probe() {
      const serve = CONFIG.gatewayMode === 'tailscale-serve';
      const host = serve ? await tailnetAddress() : '127.0.0.1';
      if (!host) return { ok: false, detail: 'No private network address yet.' };
      if (!(await tcp(CONFIG.gatewayPort, 3000, host))) return { ok: false, detail: 'Not running.' };
      if (!CONFIG.publicName) return { ok: true, detail: 'Accepting connections (set WIZARD_PUBLIC_NAME for a full check).' };
      const r = await frontDoorTrip({ host, port: CONFIG.gatewayPort, proxyHeader: !serve });
      if (!r.ok) return { ok: false, detail: r.detail };
      return r.days < 7 ? { ok: false, detail: `Security certificate expires in ${r.days} days.` } : { ok: true, detail: `Routing correctly · certificate valid for ${r.days} days.` };
    },
  },
  {
    id: 'signin', label: 'Device sign-in check', unit: CONFIG.authUnit, threshold: 2, enabled: () => CONFIG.authPort > 0,
    explain: 'Confirms each request comes from one of your own devices.',
    async probe() {
      const r = await httpGet({ port: CONFIG.authPort, path: '/verify', timeout: 4000 });
      return r.status ? { ok: true, detail: 'Answering.' } : { ok: false, detail: notAnswering(r) };
    },
  },
  {
    id: 'shell', label: 'Wizard app screens', container: CONFIG.shellContainer, threshold: 2,
    explain: 'Serves the Wizard interface itself (Home, Chats, apps).',
    async probe() {
      const r = await httpGet({ port: CONFIG.shellPort, path: CONFIG.shellPath, timeout: 5000 });
      return r.status === 200 ? { ok: true, detail: `Loads in ${r.ms} ms.` } : { ok: false, detail: r.status ? `Returned an error (${r.status}).` : notAnswering(r) };
    },
  },
  {
    id: 'agent-service', label: 'Agent Service', unit: CONFIG.agentContainer ? '' : CONFIG.agentUnit, container: CONFIG.agentContainer, threshold: 3, rollback: true,
    explain: 'Takes your messages, voice notes and files and hands them to your agent.',
    async probe() {
      const r = await httpGet({ port: CONFIG.agentPort, path: '/wizard/health', timeout: CONFIG.agentHealthTimeoutMs });
      if (!r.status) {
        // Down means not answering at all. A service that answers its front page at once but is slow with its full
        // status is busy waiting on Hermes: restarting it cannot help and would cut off messages being sent.
        if (r.error !== 'not running' && await agentAnswers()) return { ok: false, busy: true, detail: `Running, but slow to report its status (${bare(r.error)}). Hermes is probably taking a long time to accept new messages; they are saved and will send.` };
        return withCrashLoop(this.unit, { ok: false, detail: notAnswering(r) });
      }
      const h = json(r.body);
      if (r.status !== 200 || h?.status !== 'ok') return { ok: false, detail: `Unhealthy (HTTP ${r.status}).` };
      const q = h.queue || {};
      const base = `Answering in ${r.ms} ms · ${q.active ?? 0} running, ${q.queued ?? 0} waiting${q.dispatch_paused ? ' · sending paused' : ''}`;
      if (q.hermes_slow_to_accept) return { ok: true, busy: true, slow: true, detail: `${base} · Hermes has taken ${waited(q.launch_waiting_s)} to accept a new message so far; messages are saved and will send.`, extra: { upstream: h.upstream_reachable } };
      return { ok: true, detail: `${base}.`, slow: r.ms > 3000, extra: { upstream: h.upstream_reachable } };
    },
  },
  {
    id: 'hermes', label: 'Your agent (Hermes)', unit: CONFIG.hermesUnit, container: CONFIG.hermesUnit ? '' : CONFIG.hermesContainer, threshold: 3, disruptive: true,
    explain: 'The agent that thinks, uses tools and writes replies.',
    async probe() {
      // A drain restart in progress is not an outage to fix: the guardian leaves it alone (busy) and nobody restarts
      // it a second time. Its health may still answer, or not answer for the seconds between processes.
      const rs = await hermesRestartState();
      if (restartInProgress(rs)) return { ok: false, busy: true, restarting: true, detail: restartNote(rs), fix: rs.forcedAt ? null : 'force-restart:hermes' };
      if (!CONFIG.hermesPort) {
        const a = await httpGet({ port: CONFIG.agentPort, path: '/wizard/health', timeout: CONFIG.agentHealthTimeoutMs });
        if (!a.status && a.error !== 'not running' && await agentAnswers()) return { ok: false, busy: true, detail: 'Unknown right now: the Agent Service, which reaches it, is busy.' };
        const up = json(a.body)?.upstream_reachable;
        if (!a.status || up === undefined) return { ok: false, detail: 'Unknown: the Agent Service, which reaches it, is not answering.' };
        return up ? { ok: true, detail: 'Answering (seen from the Agent Service).' } : { ok: false, detail: 'The Agent Service cannot reach it.' };
      }
      const r = await httpGet({ port: CONFIG.hermesPort, path: '/health', timeout: 15000 });
      if (!r.status) return withCrashLoop(this.unit, { ok: false, detail: notAnswering(r) });
      const h = json(r.body);
      const landed = rs.state === 'restarted' ? ` ${restartNote(rs)}` : '';
      return r.status === 200 && h?.status === 'ok' ? { ok: true, detail: `Answering (version ${h.version || '?'}).${landed}`, ...(landed ? { restarted: true } : {}) } : { ok: false, detail: `Unhealthy (HTTP ${r.status}).${landed}` };
    },
  },
  {
    // 8 Nov 2026: from 12:35 UTC Hermes accepted every reply and started none, for over an hour, while every check
    // here stayed green (they only ask "are you alive?"). The Agent Service now reports replies Hermes accepted and
    // has not started although nothing else works on their thread. That is an incident even when health is green.
    // Restarting Hermes interrupts other agents' work, so the guardian never does it by itself: the page and the
    // repair chat offer it (fixWith) for the owner to confirm.
    id: 'replies-start', label: 'Replies are starting', threshold: 1, noAutoFix: true, incident: true, fixWith: 'restart:hermes',
    explain: 'Checks that a message your agent took is actually being worked on, not just accepted.',
    async probe() {
      const r = await httpGet({ port: CONFIG.agentPort, path: '/wizard/health', timeout: CONFIG.agentHealthTimeoutMs });
      const q = r.status === 200 ? json(r.body)?.queue : null;
      if (!q || q.replies_not_started === undefined) return { ok: true, detail: 'Unknown right now (the Agent Service is not reporting it).' };
      const stalled = +q.replies_not_started_s || 0, gaveUp = +q.replies_given_up_15m || 0;
      if (stalled >= CONFIG.replyStartLimitS) return { ok: false, stalledS: stalled, detail: `Your agent took a message ${waited(stalled)} ago and hasn't started on it, though it says it is fine. Restarting your agent (Hermes) usually clears this.` };
      if (gaveUp) return { ok: false, stalledS: 0, detail: `${gaveUp === 1 ? 'A message' : `${gaveUp} messages`} your agent took in the last 15 min never started, even after Wizard sent ${gaveUp === 1 ? 'it' : 'them'} again. Restarting your agent (Hermes) usually clears this.` };
      return { ok: true, detail: q.replies_not_started ? `A reply is waiting to start (${waited(stalled)} so far).` : 'Replies start normally.' };
    },
  },
  {
    // The run keeper holds reply streams so they survive Agent Service restarts (wizard-run-keeper.service). Only on
    // boxes that have it installed as a user unit.
    id: 'run-keeper', label: 'Reply keeper', unit: CONFIG.runKeeperUnit, threshold: 2,
    enabled: () => !!CONFIG.runKeeperUnit && (process.env.RUN_KEEPER_UNIT !== undefined || fs.existsSync(path.join(HOME, '.config/systemd/user', CONFIG.runKeeperUnit))),
    explain: 'Holds the replies being written so they keep reaching your devices while Wizard updates.',
    async probe() {
      const ok = await new Promise(resolve => {
        const s = net.connect({ path: CONFIG.runKeeperSocket });
        const done = v => { s.destroy(); resolve(v); };
        s.setTimeout(3000, () => done(false)); s.on('connect', () => done(true)); s.on('error', () => done(false));
      });
      return ok ? { ok: true, detail: 'Running.' } : withCrashLoop(this.unit, { ok: false, detail: 'Not running.' });
    },
  },
  {
    id: 'disk', label: 'Server storage', threshold: 1, noAutoFix: true,
    explain: 'When the disk fills up, services crash and messages cannot be saved.',
    async probe() {
      try {
        const s = fs.statfsSync('/');
        const used = 1 - s.bavail / s.blocks;
        const freeGb = (s.bavail * s.bsize) / 2 ** 30;
        return { ok: used < 0.95, detail: `${Math.round(used * 100)}% full, ${freeGb.toFixed(0)} GB free.` };
      } catch (e) { return { ok: false, detail: e.message }; }
    },
  },
  {
    id: 'memory', label: 'Server memory', threshold: 1, noAutoFix: true,
    explain: 'Very low memory makes everything slow and can crash services.',
    async probe() {
      const free = os.freemem(), total = os.totalmem();
      let avail = free;
      try { const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/); if (m) avail = +m[1] * 1024; } catch {}
      return { ok: avail / total > 0.05, detail: `${(avail / 2 ** 30).toFixed(1)} GB of ${(total / 2 ** 30).toFixed(0)} GB available.` };
    },
  },
  {
    // An app that opens inside Wizard at its own path (/messenger/) must keep that path as its launcher address.
    // The fix re-runs the box's `wam links` after backing up apps.json/links.json; it restarts nothing, so the
    // guardian applies it even in report-only mode (safeFix) unless GUARDIAN_HEAL_ADDRESSES=0.
    id: 'app-addresses', label: 'Apps open inside Wizard', threshold: 2, safeFix: true, enabled: () => CONFIG.appAddresses,
    explain: 'Each app keeps its address on the Wizard origin, so it opens in its window instead of a dead screen.',
    async probe() {
      const r = inspectAddresses(launcherFiles(), loadRemembered(CONFIG.stateDir));
      if (!r.skipped) { try { saveRemembered(CONFIG.stateDir, r.remembered); } catch {} }
      return { ok: r.ok, detail: r.detail };
    },
  },
];
ALL_CHECKS.push({ id: 'agent-reply', label: 'Your agent can reply', threshold: 2, replyProbe: true, enabled: () => CONFIG.replyProbes, explain: 'Sends one tiny real message through your main agent, not just a service health check.', probe: options => agentReply(CONFIG, run, options) });
for (const engine of ['claude', 'chatgpt', 'tinfoil']) ALL_CHECKS.push({ id: `reply-${engine}`, label: `${engine === 'claude' ? 'Claude' : engine === 'chatgpt' ? 'ChatGPT' : 'Tinfoil'} can answer repair chats`, threshold: 2, noAutoFix: true, replyProbe: true, enabled: () => CONFIG.replyProbes, explain: 'Sends a tiny real message directly to this repair engine.', async probe(options) { const { engineReply } = await import('./providers.mjs'); return engineReply(engine, options); } });
export const CHECKS = ALL_CHECKS.filter(c => !c.enabled || c.enabled());

// One-tap fixes. Only these named actions exist; nothing here takes free-form input. Built from the host layout:
// a link with a user unit restarts the unit, a link with a container restarts the container, anything else has no fix.
const LABELS = {
  tailscale: ['Restart private network', 'Your connection drops for a few seconds.'],
  gateway: ['Restart secure gateway', 'This page reloads after a few seconds.'],
  signin: ['Restart sign-in check', ''],
  shell: ['Restart Wizard app screens', ''],
  'agent-service': ['Restart Agent Service', 'Messages sent during the restart wait and send afterwards.'],
  hermes: ['Restart your agent (Hermes)', 'Replies being written right now are interrupted and resume afterwards.'],
  'run-keeper': ['Restart reply keeper', 'Replies being written right now may pause and resume afterwards.'],
};
export const ACTIONS = {};
for (const c of CHECKS) {
  const [label, warn] = LABELS[c.id] || [];
  if (!label) continue;
  // App Manager must recreate an app-managed Agent Service so its saved secrets, mounts and owner overrides are
  // re-applied. A raw `docker restart` only restarts the already-broken container and cannot repair missing env.
  const appManagedAgent = c.id === 'agent-service' && c.container;
  const cmd = appManagedAgent
    ? (fs.existsSync(CONFIG.wam) ? [CONFIG.wam, ['app', 'restart', 'wizard-agent-service']] : null)
    : c.unit ? ['systemctl', ['--user', 'restart', c.unit]]
      : c.container ? [CONFIG.docker, ['restart', c.container]] : null;
  // `wam app restart` waits up to 300 s for Runtipi to report running; don't kill it at the 120 s default.
  if (cmd) ACTIONS[`restart:${c.id}`] = { label, cmd, warn, timeout: c.id === 'hermes' ? 180000 : appManagedAgent ? 330000 : undefined };
  // Hermes as a user unit with its CLI on this box: the gateway's own drain restart. `--interrupt` is the owner's
  // confirmation that replies in progress may be paused (the CLI otherwise refuses whenever any session is live);
  // they resume after the restart.
  if (c.id === 'hermes' && c.unit && fs.existsSync(CONFIG.hermesBin)) {
    ACTIONS['restart:hermes'] = { label, warn: `Your agent finishes or pauses the replies it is writing, then restarts by itself. Other work (scheduled tasks too) can hold it for at most ${Math.round(CONFIG.hermesForceAfterMs / 60e3)} min; it resumes afterwards.`,
      drain: [CONFIG.hermesBin, 'gateway', 'restart', '--interrupt'], cmd: [CONFIG.hermesBin, ['gateway', 'restart', '--interrupt']] };
  }
  // A restart that is draining and holding every new message back (anyone's: an update, a reload, the owner's own).
  // Shown only while one is (onlyWhenNeeded).
  if (c.id === 'hermes' && c.unit) {
    ACTIONS['force-restart:hermes'] = { label: 'Restart your agent now', force: true, onlyWhenNeeded: true,
      warn: 'Stops waiting for the work your agent is finishing. That work is paused and resumes after the restart; your agent is back within a few minutes.' };
  }
  if (c.id === 'agent-service' && fs.existsSync(CONFIG.deployBin)) {
    ACTIONS['rollback:agent-service'] = { label: 'Undo the last Agent Service update', cmd: [CONFIG.deployBin, ['--rollback']], timeout: 600000, warn: 'Returns the Agent Service to the version before the last update.' };
  }
}

if (CHECKS.some(c => c.id === 'app-addresses') && fs.existsSync(CONFIG.wam)) {
  ACTIONS['restart:app-addresses'] = { label: 'Repair app addresses', timeout: 330000,
    cmd: [process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'repair-app-addresses.mjs')]],
    warn: 'Backs up the app list, then App Manager publishes every app address again. Nothing restarts.' };
}

export async function runChecks(options = {}) {
  const results = await Promise.all(CHECKS.filter(c => options.repairEngineProbes !== false || !c.id.startsWith('reply-')).map(async c => {
    let r;
    try { r = await c.probe(options); } catch (e) { r = { ok: false, detail: String(e.message || e) }; }
    // A restart already under way offers no second one, only "Restart now" while it holds messages back.
    const fix = r.restarting ? (r.fix && ACTIONS[r.fix] ? r.fix : null) : fixActionFor(c.id);
    return { id: c.id, label: c.label, explain: c.explain, ok: !!r.ok, slow: !!r.slow, busy: !!r.busy, detail: r.detail, ...(c.replyProbe ? { state: r.state, skipped: !!r.skipped, provider: r.provider, checkedAt: r.checkedAt, cached: !!r.cached } : {}), ...(r.stalledS !== undefined ? { stalledS: r.stalledS } : {}), ...(r.restarting ? { restarting: true } : {}), ...(r.crashLoop ? { crashLoop: r.crashLoop } : {}), fixable: !!fix, ...(fix ? { fix } : {}), rollback: !!ACTIONS[`rollback:${c.id}`] };
  }));
  // While Hermes drains, a check whose fix is restarting Hermes (replies not starting) points at "Restart now" instead.
  const draining = results.find(r => r.id === 'hermes' && r.restarting);
  if (draining) for (const r of results) if (r.fix === 'restart:hermes') { if (draining.fix) r.fix = draining.fix; else { delete r.fix; r.fixable = false; } }
  const bad = results.filter(r => !r.ok && !r.skipped);
  const core = ['tailscale', 'gateway', 'signin', 'shell', 'agent-service', 'hermes', 'agent-reply', 'replies-start'];
  // Busy (alive but waiting on Hermes) is degraded, not down: messages are saved and will send.
  const overall = !bad.length ? 'ok' : bad.some(b => core.includes(b.id) && !b.busy) ? 'down' : 'degraded';
  const summary = !bad.length ? 'Everything is working.' : `${bad[0].label}: ${bad[0].detail}`;
  return { at: new Date().toISOString(), overall, summary, checks: results };
}

// Keep the original account-check API for callers on older boxes, backed by real reply probes now.
export async function accountChecks(options = {}) {
  const { engineReply } = await import('./providers.mjs');
  return Promise.all([['claude', 'Claude subscription'], ['chatgpt', 'ChatGPT subscription']].map(async ([id, label]) => ({ id, label, ...await engineReply(id, options) })));
}

export function deployInProgress() {
  // The Agent Service deploy script holds an flock on deploy.lock while it switches releases.
  if (!fs.existsSync(CONFIG.releaseRoot)) return Promise.resolve(false);
  return run('flock', ['-n', path.join(CONFIG.releaseRoot, 'deploy.lock'), 'true'], { timeout: 3000 }).then(r => !r.ok);
}

export async function lastAgentRelease() {
  try {
    const link = path.join(CONFIG.releaseRoot, 'current');
    const st = fs.lstatSync(link);
    return { target: path.basename(fs.readlinkSync(link)), changedAt: st.mtimeMs };
  } catch { return null; }
}

export async function doAction(id) {
  const a = ACTIONS[id];
  if (!a) throw new Error('Unknown action');
  if (process.env.REPAIR_STANDBY_LOCK && fs.existsSync(process.env.REPAIR_STANDBY_LOCK)) return { ok: false, detail: 'Standby role fence: mutations disabled.' };
  if (id.endsWith(':hermes') && process.env.REPAIR_PROTECT_HERMES === '1') return { ok: false, detail: 'Gateway self-stop guard: Hermes restart requires an idle out-of-band operator.' };
  if (id.endsWith(':agent-service') && await deployInProgress()) return { ok: false, detail: 'An Agent Service update is being installed right now. Wait a minute and check again.' };
  if (a.drain) return drainRestartHermes(a);
  if (a.force) return forceRestartHermes(a);
  const [cmd, args] = a.cmd;
  const r = await run(cmd, args, { timeout: a.timeout || 120000 });
  return { ok: r.ok, detail: r.ok ? `${a.label}: done.` : `${a.label} failed: ${(r.err || r.out).slice(-400)}` };
}

export function fixActionFor(checkId) {
  const via = ALL_CHECKS.find(c => c.id === checkId)?.fixWith;
  if (via) return ACTIONS[via] ? via : null;
  return ACTIONS[`restart:${checkId}`] ? `restart:${checkId}` : null;
}

// A fix may run while its own link looks healthy when another failing check names it as the fix (8 Nov 2026:
// Hermes answered /health while starting no replies). Returns that check, or null.
export function failingCheckFixedBy(action, checks) {
  return checks.find(c => !c.ok && !c.skipped && !c.busy && c.fix === action && c.id !== action.split(':')[1]) || null;
}

// Plain description of this box for the repair brief, so the model never guesses unit names or ports.
export function wiring() {
  const L = [];
  const byId = Object.fromEntries(CHECKS.map(c => [c.id, c]));
  const how = c => c?.unit ? `user unit \`${c.unit}\`` : c?.container ? `Docker container \`${c.container}\`` : 'not restartable from here';
  L.push(`- Private network: Tailscale (local API socket \`${CONFIG.tailscaleSocket}\`), ${how(byId.tailscale)}.`);
  L.push(CONFIG.gatewayMode === 'tailscale-serve'
    ? `- HTTPS front door: Tailscale Serve on https://${CONFIG.publicName || '<name>'}:${CONFIG.gatewayPort} (\`tailscale serve status\`). Before any route change back it up: \`tailscale serve status --json > ~/.wizard-os/tailscale-serve.bak-<time>.json\`, and run tailscale with \`</dev/null\` and a timeout.`
    : `- HTTPS front door: Caddy on 127.0.0.1:${CONFIG.gatewayPort} (PROXY protocol), ${how(byId.gateway)}.`);
  if (byId.signin) L.push(`- Device sign-in check on 127.0.0.1:${CONFIG.authPort}, ${how(byId.signin)}.`);
  L.push(`- Wizard shell (app screens) on 127.0.0.1:${CONFIG.shellPort}${CONFIG.shellPath}, ${how(byId.shell)}.`);
  L.push(`- Agent Service on 127.0.0.1:${CONFIG.agentPort} (health \`/wizard/health\`), ${how(byId['agent-service'])}.${ACTIONS['rollback:agent-service'] ? ` Undo the last update: \`${CONFIG.deployBin} --rollback\`.` : ''}`);
  L.push(CONFIG.hermesPort
    ? `- Hermes agent runtime on 127.0.0.1:${CONFIG.hermesPort} (\`/health\`), ${how(byId.hermes)}. Logs: \`~/.hermes/logs/\`${byId.hermes?.unit ? ` and \`journalctl --user -u ${byId.hermes.unit}\`` : ''}.`
    : `- Hermes agent runtime: no host port; the Agent Service reaches it (its \`/wizard/health\` reports \`upstream_reachable\`), ${how(byId.hermes)}.${byId.hermes?.container ? ` Logs: \`${CONFIG.docker} logs ${byId.hermes.container}\`.` : ''}`);
  if (ACTIONS['restart:hermes']?.drain) L.push(`- \`restart:hermes\` is Hermes's drain restart (\`${CONFIG.hermesBin} gateway restart --interrupt\`, run in its own unit outside the gateway; \`systemctl restart\` of the gateway is fenced off). It takes minutes: the gateway drains (journal \`runtime_draining\`), then a new process starts. While it drains the PID and start time are unchanged; that is a restart in progress, never a failed one. check_status reports it as BUSY "Restart in progress".`);
  if (ACTIONS['force-restart:hermes']) L.push(`- \`force-restart:hermes\` (Restart your agent now): only while a restart is draining. It stops the wait (SIGTERM to the gateway's main process via \`systemctl --user kill --kill-whom=main\`; the gateway pauses its turns, which resume, and systemd starts a new process). An owner-asked \`restart:hermes\` does this by itself after ${Math.round(CONFIG.hermesForceAfterMs / 1000)} s, so scheduled tasks never hold the owner's messages back for long.`);
  if (byId['run-keeper']) L.push(`- Reply keeper (holds reply streams across Agent Service restarts): socket \`${CONFIG.runKeeperSocket}\`, ${how(byId['run-keeper'])}.`);
  L.push('- Connection apps (Docker, Runtipi): Claude (`/wizard-claude/`), ChatGPT (`/wizard-chatgpt/`), Tinfoil (`/wizard-tinfoil/`). They hold the AI sign-ins this repair chat uses.');
  L.push('- `wizard-troubleshooter.service` is THIS page\'s service. Never stop or restart it: you run inside it.');
  L.push(`- \`wizard-guardian.timer\`: minute-by-minute checks. Incident log: \`${path.join(CONFIG.stateDir, 'incidents.jsonl')}\`.`);
  L.push(`- One-tap fixes available here: ${Object.entries(ACTIONS).map(([k, a]) => `\`${k}\` (${a.label})`).join(', ') || 'none'}.`);
  return L.join('\n');
}

// Incident log (append-only JSONL), shared with the guardian.
const INCIDENTS = path.join(CONFIG.stateDir, 'incidents.jsonl');
export function logIncident(event) {
  fs.appendFileSync(INCIDENTS, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
}
export function readIncidents(limit = 50) {
  try {
    return fs.readFileSync(INCIDENTS, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l => json(l)).filter(Boolean).reverse();
  } catch { return []; }
}

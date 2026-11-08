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
import { execFile } from 'node:child_process';
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

async function tailnetAddress() {
  if (CONFIG.gatewayHost) return CONFIG.gatewayHost;
  const r = await httpGet({ socketPath: CONFIG.tailscaleSocket, path: '/localapi/v0/status', headers: { Host: 'local-tailscaled.sock' }, timeout: 4000 });
  return json(r.body)?.Self?.TailscaleIPs?.find(ip => net.isIP(ip) === 4) || '';
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
        return { ok: false, detail: notAnswering(r) };
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
      if (!CONFIG.hermesPort) {
        const a = await httpGet({ port: CONFIG.agentPort, path: '/wizard/health', timeout: CONFIG.agentHealthTimeoutMs });
        if (!a.status && a.error !== 'not running' && await agentAnswers()) return { ok: false, busy: true, detail: 'Unknown right now: the Agent Service, which reaches it, is busy.' };
        const up = json(a.body)?.upstream_reachable;
        if (!a.status || up === undefined) return { ok: false, detail: 'Unknown: the Agent Service, which reaches it, is not answering.' };
        return up ? { ok: true, detail: 'Answering (seen from the Agent Service).' } : { ok: false, detail: 'The Agent Service cannot reach it.' };
      }
      const r = await httpGet({ port: CONFIG.hermesPort, path: '/health', timeout: 15000 });
      if (!r.status) return { ok: false, detail: notAnswering(r) };
      const h = json(r.body);
      return r.status === 200 && h?.status === 'ok' ? { ok: true, detail: `Answering (version ${h.version || '?'}).` } : { ok: false, detail: `Unhealthy (HTTP ${r.status}).` };
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
    const fix = fixActionFor(c.id);
    return { id: c.id, label: c.label, explain: c.explain, ok: !!r.ok, slow: !!r.slow, busy: !!r.busy, detail: r.detail, ...(c.replyProbe ? { state: r.state, skipped: !!r.skipped, provider: r.provider, checkedAt: r.checkedAt, cached: !!r.cached } : {}), ...(r.stalledS !== undefined ? { stalledS: r.stalledS } : {}), fixable: !!fix, ...(fix ? { fix } : {}), rollback: !!ACTIONS[`rollback:${c.id}`] };
  }));
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
  if (id === 'restart:hermes' && process.env.REPAIR_PROTECT_HERMES === '1') return { ok: false, detail: 'Gateway self-stop guard: Hermes restart requires an idle out-of-band operator.' };
  if (id.endsWith(':agent-service') && await deployInProgress()) return { ok: false, detail: 'An Agent Service update is being installed right now. Wait a minute and check again.' };
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

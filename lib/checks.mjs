// Wizard Troubleshooter: health checks and one-tap fixes for every link between the
// user's device and their agent. Shared by the HTTP service and the guardian timer.
// Deliberately stdlib-only and independent of the Agent Service, Hermes and the shell.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HOME = os.homedir();
export const CONFIG = {
  tailscaleSocket: process.env.TS_SOCKET || `/run/user/${process.getuid()}/tailscale-private-gateway.sock`,
  gatewayPort: +(process.env.GATEWAY_PORT || 19445),
  authPort: +(process.env.AUTH_PORT || 19447),
  shellPort: +(process.env.SHELL_PORT || 8928),
  agentPort: +(process.env.AGENT_PORT || 8923),
  hermesPort: +(process.env.HERMES_PORT || 8642),
  publicName: process.env.WIZARD_PUBLIC_NAME || 'wizard.tailc0f369.ts.net',
  shellContainer: process.env.SHELL_CONTAINER || 'wizard-interface-candidate',
  releaseRoot: process.env.WAS_RELEASE_ROOT || path.join(HOME, '.local/share/wizard-mobile-server'),
  deployBin: process.env.WAS_DEPLOY_BIN || path.join(HOME, '.local/bin/wizard-agent-service-deploy'),
  stateDir: process.env.TROUBLESHOOT_STATE || path.join(HOME, '.local/state/wizard-troubleshooter'),
};
fs.mkdirSync(CONFIG.stateDir, { recursive: true, mode: 0o700 });

export function run(cmd, args, { timeout = 60000, env } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, env: env || process.env, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
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

function tcp(port, timeout = 3000) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// Full trip through the HTTPS front door exactly as a device arrives (PROXY header, TLS with the real name).
function frontDoorTrip(timeout = 6000) {
  return new Promise(resolve => {
    const raw = net.connect({ host: '127.0.0.1', port: CONFIG.gatewayPort });
    let done = false, sock;
    const finish = v => { if (done) return; done = true; clearTimeout(timer); try { sock?.destroy(); raw.destroy(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish({ ok: false, detail: 'Accepted the connection but did not answer.' }), timeout);
    raw.on('error', e => finish({ ok: false, detail: `Connection error: ${e.message}.` }));
    raw.on('connect', () => {
      raw.write('PROXY TCP4 127.0.0.1 127.0.0.1 40000 443\r\n');
      sock = tls.connect({ socket: raw, servername: CONFIG.publicName }, () => {
        const cert = sock.getPeerCertificate();
        const days = cert?.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 864e5) : -1;
        if (!sock.authorized) return finish({ ok: false, detail: `Security certificate problem: ${sock.authorizationError}.` });
        sock.write(`GET /troubleshoot/api/ping HTTP/1.1\r\nHost: ${CONFIG.publicName}\r\nConnection: close\r\n\r\n`);
        let buf = '';
        sock.on('data', d => { buf += d; });
        sock.on('end', () => { const code = +(buf.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] || 0); finish(code === 200 ? { ok: true, days } : { ok: false, detail: `Answered with an error (${code || 'no status'}).` }); });
      });
      sock.on('error', e => finish({ ok: false, detail: `Secure connection failed: ${e.message}.` }));
    });
  });
}

const notAnswering = r => r.error === 'not running' ? 'Not running.' : `Not answering: ${r.error}.`;
const json = s => { try { return JSON.parse(s); } catch { return null; } };

// Each check: id, label (plain words), what it means for the user, how to fix it.
export const CHECKS = [
  {
    id: 'tailscale', label: 'Private network (Tailscale)', unit: 'tailscale-private-gateway.service', threshold: 2,
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
    id: 'gateway', label: 'Secure gateway', unit: 'private-gateway-https.service', threshold: 2,
    explain: 'The HTTPS front door that routes every Wizard page and app.',
    async probe() {
      if (!(await tcp(CONFIG.gatewayPort))) return { ok: false, detail: 'Not running.' };
      const r = await frontDoorTrip();
      if (!r.ok) return { ok: false, detail: r.detail };
      return r.days < 7 ? { ok: false, detail: `Security certificate expires in ${r.days} days.` } : { ok: true, detail: `Routing correctly · certificate valid for ${r.days} days.` };
    },
  },
  {
    id: 'signin', label: 'Device sign-in check', unit: 'private-tailnet-auth.service', threshold: 2,
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
      const r = await httpGet({ port: CONFIG.shellPort, path: '/wizard-os-home/', timeout: 5000 });
      return r.status === 200 ? { ok: true, detail: `Loads in ${r.ms} ms.` } : { ok: false, detail: r.status ? `Returned an error (${r.status}).` : notAnswering(r) };
    },
  },
  {
    id: 'agent-service', label: 'Agent Service', unit: 'wizard-mobile.service', threshold: 3, rollback: true,
    explain: 'Takes your messages, voice notes and files and hands them to your agent.',
    async probe() {
      const r = await httpGet({ port: CONFIG.agentPort, path: '/wizard/health', timeout: 15000 });
      if (!r.status) return { ok: false, detail: notAnswering(r) };
      const h = json(r.body);
      if (r.status !== 200 || h?.status !== 'ok') return { ok: false, detail: `Unhealthy (HTTP ${r.status}).` };
      const q = h.queue || {};
      return { ok: true, detail: `Answering in ${r.ms} ms · ${q.active ?? 0} running, ${q.queued ?? 0} waiting${q.dispatch_paused ? ' · sending paused' : ''}.`, slow: r.ms > 3000, extra: { upstream: h.upstream_reachable } };
    },
  },
  {
    id: 'hermes', label: 'Your agent (Hermes)', unit: 'hermes-gateway.service', threshold: 3, disruptive: true,
    explain: 'The agent that thinks, uses tools and writes replies.',
    async probe() {
      const r = await httpGet({ port: CONFIG.hermesPort, path: '/health', timeout: 15000 });
      if (!r.status) return { ok: false, detail: notAnswering(r) };
      const h = json(r.body);
      return r.status === 200 && h?.status === 'ok' ? { ok: true, detail: `Answering (version ${h.version || '?'}).` } : { ok: false, detail: `Unhealthy (HTTP ${r.status}).` };
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
];

export async function runChecks() {
  const results = await Promise.all(CHECKS.map(async c => {
    let r;
    try { r = await c.probe(); } catch (e) { r = { ok: false, detail: String(e.message || e) }; }
    return { id: c.id, label: c.label, explain: c.explain, ok: !!r.ok, slow: !!r.slow, detail: r.detail, fixable: !!(c.unit || c.container), rollback: !!c.rollback };
  }));
  const bad = results.filter(r => !r.ok);
  const core = ['tailscale', 'gateway', 'signin', 'shell', 'agent-service', 'hermes'];
  const overall = !bad.length ? 'ok' : bad.some(b => core.includes(b.id)) ? 'down' : 'degraded';
  const summary = !bad.length ? 'Everything is working.' : `${bad[0].label}: ${bad[0].detail}`;
  return { at: new Date().toISOString(), overall, summary, checks: results };
}

export async function accountChecks() {
  const out = [];
  const claude = await run(path.join(HOME, '.local/bin/claude'), ['auth', 'status'], { timeout: 20000 });
  const cj = json(claude.out);
  out.push({ id: 'claude', label: 'Claude subscription', ok: claude.ok && (cj ? cj.loggedIn !== false : !/not (logged|signed) in/i.test(claude.out)), detail: cj ? (cj.loggedIn ? `Signed in${cj.authMethod === 'claude.ai' ? ' with your Claude subscription' : ''}.` : 'Signed out.') : (claude.out || claude.err).split('\n')[0].slice(0, 160) });
  const codex = await run(path.join(HOME, '.local/bin/codex'), ['login', 'status'], { timeout: 20000 });
  const ctext = (codex.out || codex.err).split('\n').find(Boolean) || '';
  out.push({ id: 'chatgpt', label: 'ChatGPT subscription', ok: codex.ok && /logged in/i.test(ctext), detail: ctext.slice(0, 160) });
  return out;
}

export function deployInProgress() {
  // The Agent Service deploy script holds an flock on deploy.lock while it switches releases.
  return run('flock', ['-n', path.join(CONFIG.releaseRoot, 'deploy.lock'), 'true'], { timeout: 3000 }).then(r => !r.ok);
}

export async function lastAgentRelease() {
  try {
    const link = path.join(CONFIG.releaseRoot, 'current');
    const st = fs.lstatSync(link);
    return { target: path.basename(fs.readlinkSync(link)), changedAt: st.mtimeMs };
  } catch { return null; }
}

// One-tap fixes. Only these named actions exist; nothing here takes free-form input.
export const ACTIONS = {
  'restart:tailscale': { label: 'Restart private network', cmd: ['systemctl', ['--user', 'restart', 'tailscale-private-gateway.service']], warn: 'Your connection drops for a few seconds.' },
  'restart:gateway': { label: 'Restart secure gateway', cmd: ['systemctl', ['--user', 'restart', 'private-gateway-https.service']], warn: 'This page reloads after a few seconds.' },
  'restart:signin': { label: 'Restart sign-in check', cmd: ['systemctl', ['--user', 'restart', 'private-tailnet-auth.service']] },
  'restart:shell': { label: 'Restart Wizard app screens', cmd: ['docker', ['restart', CONFIG.shellContainer]] },
  'restart:agent-service': { label: 'Restart Agent Service', cmd: ['systemctl', ['--user', 'restart', 'wizard-mobile.service']], warn: 'Messages sent during the restart wait and send afterwards.' },
  'rollback:agent-service': { label: 'Undo the last Agent Service update', cmd: [CONFIG.deployBin, ['--rollback']], timeout: 600000, warn: 'Returns the Agent Service to the version before the last update.' },
  'restart:hermes': { label: 'Restart your agent (Hermes)', cmd: ['systemctl', ['--user', 'restart', 'hermes-gateway.service']], timeout: 180000, warn: 'Replies being written right now are interrupted and resume afterwards.' },
};

export async function doAction(id) {
  const a = ACTIONS[id];
  if (!a) throw new Error('Unknown action');
  if (id.endsWith(':agent-service') && await deployInProgress()) return { ok: false, detail: 'An Agent Service update is being installed right now. Wait a minute and check again.' };
  const [cmd, args] = a.cmd;
  const r = await run(cmd, args, { timeout: a.timeout || 120000 });
  return { ok: r.ok, detail: r.ok ? `${a.label}: done.` : `${a.label} failed: ${(r.err || r.out).slice(-400)}` };
}

export function fixActionFor(checkId) {
  return ACTIONS[`restart:${checkId}`] ? `restart:${checkId}` : null;
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

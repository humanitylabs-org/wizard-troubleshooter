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
  authPort: +env('AUTH_PORT', '19447'), // 0 or empty: this box has no separate device sign-in service
  authUnit: env('AUTH_UNIT', 'private-tailnet-auth.service'),
  shellPort: +(process.env.SHELL_PORT || 8928),
  shellPath: process.env.SHELL_PATH || '/wizard-os-home/',
  shellContainer: env('SHELL_CONTAINER', 'wizard-interface-candidate'),
  agentPort: +(process.env.AGENT_PORT || 8923),
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
  docker: process.env.DOCKER_BIN || 'docker',
  stateDir: process.env.TROUBLESHOOT_STATE || path.join(HOME, '.local/state/wizard-troubleshooter'),
};
fs.mkdirSync(CONFIG.stateDir, { recursive: true, mode: 0o700 });

export function run(cmd, args, { timeout = 60000, env: e } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, env: e || process.env, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
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
      const r = await httpGet({ port: CONFIG.agentPort, path: '/wizard/health', timeout: 15000 });
      if (!r.status) return { ok: false, detail: notAnswering(r) };
      const h = json(r.body);
      if (r.status !== 200 || h?.status !== 'ok') return { ok: false, detail: `Unhealthy (HTTP ${r.status}).` };
      const q = h.queue || {};
      return { ok: true, detail: `Answering in ${r.ms} ms · ${q.active ?? 0} running, ${q.queued ?? 0} waiting${q.dispatch_paused ? ' · sending paused' : ''}.`, slow: r.ms > 3000, extra: { upstream: h.upstream_reachable } };
    },
  },
  {
    id: 'hermes', label: 'Your agent (Hermes)', unit: CONFIG.hermesUnit, container: CONFIG.hermesUnit ? '' : CONFIG.hermesContainer, threshold: 3, disruptive: true,
    explain: 'The agent that thinks, uses tools and writes replies.',
    async probe() {
      if (!CONFIG.hermesPort) {
        const a = await httpGet({ port: CONFIG.agentPort, path: '/wizard/health', timeout: 15000 });
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
  const cmd = c.unit ? ['systemctl', ['--user', 'restart', c.unit]] : c.container ? [CONFIG.docker, ['restart', c.container]] : null;
  if (cmd) ACTIONS[`restart:${c.id}`] = { label, cmd, warn, timeout: c.id === 'hermes' ? 180000 : undefined };
  if (c.id === 'agent-service' && fs.existsSync(CONFIG.deployBin)) {
    ACTIONS['rollback:agent-service'] = { label: 'Undo the last Agent Service update', cmd: [CONFIG.deployBin, ['--rollback']], timeout: 600000, warn: 'Returns the Agent Service to the version before the last update.' };
  }
}

export async function runChecks() {
  const results = await Promise.all(CHECKS.map(async c => {
    let r;
    try { r = await c.probe(); } catch (e) { r = { ok: false, detail: String(e.message || e) }; }
    return { id: c.id, label: c.label, explain: c.explain, ok: !!r.ok, slow: !!r.slow, detail: r.detail, fixable: !!ACTIONS[`restart:${c.id}`], rollback: !!ACTIONS[`rollback:${c.id}`] };
  }));
  const bad = results.filter(r => !r.ok);
  const core = ['tailscale', 'gateway', 'signin', 'shell', 'agent-service', 'hermes'];
  const overall = !bad.length ? 'ok' : bad.some(b => core.includes(b.id)) ? 'down' : 'degraded';
  const summary = !bad.length ? 'Everything is working.' : `${bad[0].label}: ${bad[0].detail}`;
  return { at: new Date().toISOString(), overall, summary, checks: results };
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
  if (id.endsWith(':agent-service') && await deployInProgress()) return { ok: false, detail: 'An Agent Service update is being installed right now. Wait a minute and check again.' };
  const [cmd, args] = a.cmd;
  const r = await run(cmd, args, { timeout: a.timeout || 120000 });
  return { ok: r.ok, detail: r.ok ? `${a.label}: done.` : `${a.label} failed: ${(r.err || r.out).slice(-400)}` };
}

export function fixActionFor(checkId) {
  return ACTIONS[`restart:${checkId}`] ? `restart:${checkId}` : null;
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

// Wizard Troubleshooter HTTP service: /troubleshoot/ on the private gateway, served straight from this
// process. Owner identity comes from the Tailscale peer (same policy as the gateway's sign-in bridge, but
// checked here so the page keeps working when that bridge, the Agent Service or Hermes is down).
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONFIG, runChecks, accountChecks, ACTIONS, doAction, logIncident, readIncidents, lastAgentRelease } from './lib/checks.mjs';
import { startRepair, loadConv, listConvs, busy, stopRepair } from './lib/repair.mjs';

function guardianToken() {
  const f = path.join(CONFIG.stateDir, 'guardian.token');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

const PORT = +(process.env.PORT || 9691);
const PREFIX = '/troubleshoot';
const ORIGINS = new Set(String(process.env.WIZARD_PRIVATE_ORIGINS || (process.env.WIZARD_PUBLIC_NAME ? `https://${process.env.WIZARD_PUBLIC_NAME}` : '')).split(',').map(s => s.trim()).filter(Boolean));
const PAGE = path.join(path.dirname(new URL(import.meta.url).pathname), 'web/index.html');
const DEV_OPEN = process.env.TROUBLESHOOT_DEV_NO_AUTH === '1'; // local tests only

function validPeer(ip) {
  return net.isIP(ip) === 4 ? /^100\./.test(ip) && +ip.split('.')[1] >= 64 && +ip.split('.')[1] <= 127
    : net.isIP(ip) === 6 && ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}
function principalFromWhois(data) {
  const node = data?.Node, user = data?.UserProfile;
  if (!node || node.Tags?.length || !user || node.User !== user.ID) return null;
  const login = user.LoginName;
  return typeof login === 'string' && /^[a-zA-Z0-9._+@-]{1,254}$/.test(login) ? login : null;
}
const whoCache = new Map();
function whois(ip) {
  const hit = whoCache.get(ip);
  if (hit && Date.now() - hit.at < 60e3) return Promise.resolve(hit.login);
  return new Promise(resolve => {
    const req = http.get({ socketPath: CONFIG.tailscaleSocket, path: '/localapi/v0/whois?addr=' + encodeURIComponent(ip), headers: { Host: 'local-tailscaled.sock' }, timeout: 2500 }, res => {
      let body = '';
      res.on('data', d => { body += d; if (body.length > 131072) req.destroy(); });
      res.on('end', () => {
        let login = null;
        try { if (res.statusCode === 200) login = principalFromWhois(JSON.parse(body)); } catch {}
        if (login) whoCache.set(ip, { login, at: Date.now() });
        resolve(login);
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow', ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readBody(req, max = 32768) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > max) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
  });
}

let statusCache = null;
async function status(fresh) {
  if (!fresh && statusCache && Date.now() - statusCache.t < 3000) return statusCache.v;
  const v = await runChecks();
  statusCache = { t: Date.now(), v };
  return v;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname;
    if (!p.startsWith(PREFIX)) return send(res, 404, { error: 'Not found' });
    p = p.slice(PREFIX.length) || '/';

    // Identity: Caddy sets X-Private-Peer from the real Tailscale connection; client copies are stripped.
    let who = 'dev';
    if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true }); // reachability only; reveals nothing
    if (req.method === 'POST' && p === '/api/guardian-repair') {
      const tok = req.headers['x-guardian-token'], want = guardianToken();
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-private-peer'] && !req.headers['x-forwarded-for'];
      if (!local || typeof tok !== 'string' || tok.length !== want.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(want))) return send(res, 403, { error: 'Forbidden' });
      const b = await readBody(req);
      return send(res, 202, await startRepair({ message: b.message, engine: 'auto', origin: 'guardian' }));
    }
    if (!DEV_OPEN) {
      const ip = req.headers['x-private-peer'];
      who = typeof ip === 'string' && validPeer(ip) ? await whois(ip) : null;
      if (!who) return send(res, 403, p.startsWith('/api/') ? { error: 'Open this from one of your own devices on your private network.' } : '<!doctype html><meta name=viewport content="width=device-width"><body style="background:#0b0d12;color:#e8eaf0;font:16px system-ui;padding:24px">Open this from one of your own devices on your private network.</body>');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (!DEV_OPEN && (!origin || !ORIGINS.has(origin))) return send(res, 403, { error: 'Cross-site request refused.' });
      if (req.headers['x-wizard-troubleshoot'] !== '1') return send(res, 403, { error: 'Missing request header.' });
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(PAGE, 'utf8'), {
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    });
    if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/api/status') {
      const s = await status(url.searchParams.get('fresh') === '1');
      const extra = url.searchParams.get('accounts') === '1' ? { accounts: await accountChecks() } : {};
      return send(res, 200, { ...s, ...extra, release: await lastAgentRelease(), repair: busy() || null, actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, { label: a.label, warn: a.warn || '' }])) });
    }
    if (req.method === 'GET' && p === '/api/incidents') return send(res, 200, { incidents: readIncidents(40) });
    if (req.method === 'POST' && p === '/api/action') {
      const { action } = await readBody(req);
      if (!ACTIONS[action]) return send(res, 400, { error: 'Unknown action' });
      logIncident({ kind: 'owner-action', action, by: who });
      const r = await doAction(action);
      logIncident({ kind: 'owner-action-result', action, ok: r.ok, detail: r.detail });
      statusCache = null;
      return send(res, r.ok ? 200 : 500, { ...r, status: await status(true) });
    }
    if (req.method === 'GET' && p === '/api/repairs') return send(res, 200, { repairs: listConvs(), running: busy() || null });
    if (req.method === 'POST' && p === '/api/repair') {
      const b = await readBody(req);
      const engine = ['auto', 'claude', 'chatgpt'].includes(b.engine) ? b.engine : 'auto';
      const r = await startRepair({ convId: b.id || null, message: b.message, engine });
      logIncident({ kind: 'repair-started', conversation: r.id, engine, by: who });
      return send(res, 202, r);
    }
    if (req.method === 'POST' && p === '/api/repair/stop') return send(res, 200, { stopped: stopRepair() });
    const m = p.match(/^\/api\/repair\/([a-f0-9]{16})$/);
    if (req.method === 'GET' && m) {
      const c = loadConv(m[1]);
      if (!c) return send(res, 404, { error: 'Not found' });
      const since = +(url.searchParams.get('since') || 0);
      return send(res, 200, { id: c.id, title: c.title, running: !!c.running, events: c.events.filter(e => e.seq > since) });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'Error' });
  }
});
server.requestTimeout = 0; // actions such as a rollback can take minutes
server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`Wizard Troubleshooter on 127.0.0.1:${PORT}${PREFIX}/`));

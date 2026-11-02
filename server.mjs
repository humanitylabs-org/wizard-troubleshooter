// Wizard Troubleshooter HTTP service: /troubleshoot/ on the private gateway, served straight from this
// process. Owner identity comes from the Tailscale peer (same policy as the gateway's sign-in bridge, but
// checked here so the page keeps working when that bridge, the Agent Service or Hermes is down).
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CONFIG, runChecks, ACTIONS, doAction, logIncident, readIncidents, lastAgentRelease } from './lib/checks.mjs';
import { startRepair, loadConv, listConvs, busy, stopRepair, bridgeToken, bridgeRequest, decideApproval } from './lib/repair.mjs';
import { toolDefs } from './lib/toolloop.mjs';
import { allSignins, engineOrder, ENGINES, selectedEngine, saveEngine, appLink, META } from './lib/providers.mjs';

function guardianToken() {
  const f = path.join(CONFIG.stateDir, 'guardian.token');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

/* Browser boundary (default-off; wizard-os #133/#385, census row "troubleshooter"). Under the boundary every other
 * script on the owner's private origin is an untrusted app, so the network owner identity alone no longer authorizes
 * this listener. Its own, DISTINCT recovery gate, checked here so nothing else (Agent Service, Hermes, sign-in bridge)
 * has to be up: every /api/ call needs the recovery token (a file only the shell document's server and this process
 * read; never the shell token) and must not come from a frame or another site. The token reaches a browser only
 * inside a top-level navigation response: in the shell document (the shell's server injects it) and in this page when
 * opened as its own tab, with framing and openers cut off. Framed inside Wizard, this page is served without it as an
 * opaque document, and the shell runs fixed recovery operations for it. */
const BOUNDARY = process.env.WIZARD_BROWSER_BOUNDARY === '1';
const RECOVERY_TOKEN_FILE = process.env.WIZARD_RECOVERY_TOKEN_FILE || '';
let recoveryCache = { at: 0, mtime: 0, value: '' };
function recoveryToken() {
  // Re-read on change, so a rotation applies at once; an unreadable or malformed file fails closed (empty).
  try {
    const st = fs.statSync(RECOVERY_TOKEN_FILE);
    if (st.mtimeMs !== recoveryCache.mtime || Date.now() - recoveryCache.at > 60e3) {
      const v = fs.readFileSync(RECOVERY_TOKEN_FILE, 'utf8').trim();
      recoveryCache = { at: Date.now(), mtime: st.mtimeMs, value: /^[a-f0-9]{64}$/.test(v) ? v : '' };
    }
    return recoveryCache.value;
  } catch { return ''; }
}
if (BOUNDARY && !recoveryToken()) { console.error('WIZARD_BROWSER_BOUNDARY=1 needs WIZARD_RECOVERY_TOKEN_FILE (64 lowercase hex, distinct from the shell token)'); process.exit(2); }
const FRAME_DESTS = new Set(['iframe', 'frame', 'embed', 'object', 'fencedframe']);
function recoveryRefusal(req) {
  const origin = String(req.headers.origin ?? '').trim().toLowerCase();
  const site = req.headers['sec-fetch-site'];
  if (origin === 'null' || (site !== undefined && site !== 'same-origin')) return 'cross_site_refused';
  if (FRAME_DESTS.has(req.headers['sec-fetch-dest'])) return 'frame_refused';
  const want = recoveryToken(), got = req.headers['x-wizard-recovery-token'];
  if (!want || typeof got !== 'string' || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return 'recovery_token_required';
  return '';
}
const PAGE_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";
function boundaryPage(req) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const dest = req.headers['sec-fetch-dest'], mode = req.headers['sec-fetch-mode'];
  if (dest === 'document' && mode === 'navigate') return { status: 200, body: html.replace('<head>', `<head><meta name="wizard-recovery-token" content="${recoveryToken()}">`), headers: {
    'Content-Security-Policy': PAGE_CSP + "; frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'noopener-allow-popups', 'Cache-Control': 'private, no-store' } };
  // Inside a Wizard window: no token, and ALWAYS an opaque origin (CSP sandbox), whoever frames it.
  if (dest === 'iframe' && mode === 'navigate') return { status: 200, body: html, headers: {
    'Content-Security-Policy': PAGE_CSP + "; frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-downloads", 'Cache-Control': 'private, no-store' } };
  return { status: 403, body: { error: 'navigation_only' } };
}

const PORT = +(process.env.PORT || 9691);
const PREFIX = '/troubleshoot';
const ORIGINS = new Set(String(process.env.WIZARD_PRIVATE_ORIGINS || (process.env.WIZARD_PUBLIC_NAME ? `https://${process.env.WIZARD_PUBLIC_NAME}` : '')).split(',').map(s => s.trim()).filter(Boolean));
const PAGE = path.join(path.dirname(new URL(import.meta.url).pathname), 'web/index.html');
const DEV_OPEN = process.env.TROUBLESHOOT_DEV_NO_AUTH === '1'; // local tests only
// Where the real peer address comes from. caddy: the private gateway sets X-Private-Peer from the connection.
// tailscale-serve: Tailscale Serve proxies from loopback and overwrites X-Forwarded-For with the peer's tailnet address
// (client copies are replaced, verified on oscarvps), so only a loopback connection carrying it is trusted.
const FRONT = process.env.TROUBLESHOOT_FRONT || 'caddy';
const WHOIS_SOCKET = process.env.TS_WHOIS_SOCKET || CONFIG.tailscaleSocket;
// Optional allow-list of tailnet logins (comma separated). Empty: any human (untagged) principal on the tailnet.
const OWNERS = new Set(String(process.env.TROUBLESHOOT_OWNERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
function peerAddress(req) {
  if (FRONT === 'tailscale-serve') {
    const ra = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) return null;
    const xff = req.headers['x-forwarded-for'];
    return typeof xff === 'string' && !xff.includes(',') ? xff.trim() : null;
  }
  const ip = req.headers['x-private-peer'];
  return typeof ip === 'string' ? ip : null;
}

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
    const req = http.get({ socketPath: WHOIS_SOCKET, path: '/localapi/v0/whois?addr=' + encodeURIComponent(ip), headers: { Host: 'local-tailscaled.sock' }, timeout: 2500 }, res => {
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
  const v = await runChecks({ force: !!fresh });
  statusCache = { t: Date.now(), v };
  return v;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname;
    if (!p.startsWith(PREFIX)) return send(res, 404, { error: 'Not found' });
    p = p.slice(PREFIX.length) || '/';
    if (req.method === 'POST' && p === '/internal/repair-tools') {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const supplied = req.headers.authorization || '', expected = 'Bearer ' + bridgeToken;
      if (!local || req.headers.origin || req.headers['x-forwarded-for'] || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return send(res, 403, { error: 'Forbidden' });
      return send(res, 200, await bridgeRequest(await readBody(req, 131072)));
    }

    // Identity: Caddy sets X-Private-Peer from the real Tailscale connection; client copies are stripped.
    let who = 'dev';
    if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true }); // reachability only; reveals nothing
    if (req.method === 'POST' && p === '/api/guardian-repair') {
      const tok = req.headers['x-guardian-token'], want = guardianToken();
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-private-peer'] && !req.headers['x-forwarded-for'] && !req.headers['tailscale-user-login'];
      if (!local || typeof tok !== 'string' || tok.length !== want.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(want))) return send(res, 403, { error: 'Forbidden' });
      const b = await readBody(req);
      return send(res, 202, await startRepair({ message: b.message, engine: 'auto', origin: 'guardian' }));
    }
    if (!DEV_OPEN) {
      const ip = peerAddress(req);
      who = ip && validPeer(ip) ? await whois(ip) : null;
      const claimed = req.headers['tailscale-user-login'];
      if (who && typeof claimed === 'string' && claimed.toLowerCase() !== who.toLowerCase()) who = null; // Serve's header must agree with whois
      if (who && OWNERS.size && !OWNERS.has(who.toLowerCase())) { logIncident({ kind: 'refused', by: who }); who = null; }
      if (!who) return send(res, 403, p.startsWith('/api/') ? { error: 'Open this from one of your own devices on your private network.' } : '<!doctype html><meta name=viewport content="width=device-width"><body style="background:#0b0d12;color:#e8eaf0;font:16px system-ui;padding:24px">Open this from one of your own devices on your private network.</body>');
    }
    if (BOUNDARY && p.startsWith('/api/')) {
      const refused = recoveryRefusal(req);
      if (refused) { if (refused !== 'recovery_token_required') logIncident({ kind: 'refused', by: who, reason: refused }); return send(res, 403, { error: refused }); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (!DEV_OPEN && (!origin || !ORIGINS.has(origin))) return send(res, 403, { error: 'Cross-site request refused.' });
      if (req.headers['x-wizard-troubleshoot'] !== '1') return send(res, 403, { error: 'Missing request header.' });
    }

    if (BOUNDARY && req.method === 'GET' && (p === '/' || p === '/index.html')) { const r = boundaryPage(req); return send(res, r.status, r.body, r.headers || {}); }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(PAGE, 'utf8'), {
      'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    });
    if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/api/status') {
      const s = await status(url.searchParams.get('fresh') === '1');
      let extra = {};
      if (url.searchParams.get('accounts') === '1') { const accounts = await allSignins(); extra = { accounts, order: engineOrder('auto'), engine: selectedEngine(accounts) }; }
      const expired = s.checks.find(c => !c.ok && c.state === 'expired');
      const eng = expired && ENGINES.find(e => META[e].name === expired.provider || expired.id === `reply-${e}`);
      const reconnect = eng ? { engine: eng, ...META[eng], ...appLink(eng), state: 'expired' } : null;
      return send(res, 200, { ...s, ...extra, reconnect, release: await lastAgentRelease(), repair: busy() || null, actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, { label: a.label, warn: a.warn || '' }])) });
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
    if (req.method === 'GET' && p === '/api/engines') { const engines = await allSignins(); return send(res, 200, { engines, order: engineOrder('auto'), selected: selectedEngine(engines), tools: toolDefs(), permissions: 'shared-owner-approved-allowlist' }); }
    if (req.method === 'POST' && p === '/api/engine') { const b = await readBody(req); return send(res, 200, { selected: saveEngine(b.engine) }); }
    // Past sessions (read-only list, newest first). ?limit=1..50, default 10.
    if (req.method === 'GET' && p === '/api/repairs') return send(res, 200, { repairs: listConvs(url.searchParams.get('limit') || 10), running: busy() || null });
    if (req.method === 'POST' && p === '/api/repair') {
      const b = await readBody(req);
      const engine = ['auto', ...ENGINES].includes(b.engine) ? b.engine : 'auto';
      const r = await startRepair({ convId: b.id || null, message: b.message, engine });
      logIncident({ kind: 'repair-started', conversation: r.id, engine, by: who });
      return send(res, 202, r);
    }
    if (req.method === 'POST' && p === '/api/repair/stop') return send(res, 200, { stopped: stopRepair() });
    if (req.method === 'POST' && p === '/api/repair/approve') {
      const b = await readBody(req);
      if (typeof b.approved !== 'boolean') return send(res, 400, { error: 'Approval must be boolean' });
      const r = decideApproval(b.approvalId, b.id, b.approved);
      logIncident({ kind: 'repair-approval', by: who, approvalId: b.approvalId, approved: r.approved });
      return send(res, 200, r);
    }
    const m = p.match(/^\/api\/repair\/([a-f0-9]{16})$/);
    if (req.method === 'GET' && m) {
      const c = loadConv(m[1]);
      if (!c) return send(res, 404, { error: 'Not found' });
      const since = +(url.searchParams.get('since') || 0);
      return send(res, 200, { id: c.id, title: c.title, createdAt: c.createdAt || null, origin: c.origin, running: !!c.running, events: c.events.filter(e => e.seq > since) });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'Error' });
  }
});
server.requestTimeout = 0; // actions such as a rollback can take minutes
server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`Wizard Troubleshooter on 127.0.0.1:${PORT}${PREFIX}/`));

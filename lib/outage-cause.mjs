// Outages that keep coming back (#47, behind the `recurring-cause` switch in lib/switches.mjs). A restart only gets
// Wizard going for a while when something keeps freezing it (13 Nov 2026: a phone resent its read state ~8 times a
// second, four outages in under three hours). This names the cause from the box's own evidence, says how Wizard is
// containing it, and files one hotfix for the builder with that evidence.
//   Evidence: the Agent Service's `[event-loop]` journal lines (which routes used the loop, what ran during a stall)
//   and, when the box keeps one, the gateway's JSON access log (GUARDIAN_ACCESS_LOG, Caddy's `format json`): per
//   device request rates. One device sending most of one route's requests, a second or more apart, is a client loop.
//   Containment: the Agent Service's own per-device limit (wizard-agent-service#513), seen as `client_storm` in its
//   /wizard/health; or undoing the last update when the first outage began right after it.
//   Filing: the WizardOS Tracker's `board_report_bug` tool on this box (its /mcp, loopback), once per cause a day.
// Nothing here posts a device's address, a token or a host name: devices are named by kind (phone, computer) and a
// short one-way tag.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { CONFIG, run, httpGet } from './checks.mjs';
import { launcherFiles } from './launchers.mjs';

export const LOOP_RATE = 1; // requests a second from one device to one route that no person taps
export const LOOP_SHARE = 0.6; // of that route's requests
export const UPDATE_WINDOW = 2 * 3600e3; // the first outage began this soon after an update: the update is the suspect

const json = s => { try { return JSON.parse(s); } catch { return null; } };
const tag = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 6);
export const deviceKind = ua => /iPad|Tablet/i.test(ua || '') ? 'tablet' : /iPhone|Android|Mobile/i.test(ua || '') ? 'phone'
  : /Macintosh|Windows|Linux|CrOS|X11/i.test(ua || '') ? 'computer' : 'device';
// Ids in paths (a thread, a message) would split one loop into many routes.
export const routeOf = uri => String(uri || '').split('?')[0].replace(/\/[0-9a-f]{8,}(?=\/|$)|\/\d+(?=\/|$)|\/[\w-]{20,}(?=\/|$)/gi, '/:id').slice(0, 120) || '/';

// `[event-loop] {...}` lines (wizard-agent-service server/speed-meter.mjs lagLine), with or without a journal prefix.
export function parseEventLoop(text) {
  const routes = new Map(), running = new Map();
  let windows = 0, maxInFlight = 0, maxDelay = 0;
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('[event-loop] ');
    if (i < 0) continue;
    const v = json(line.slice(i + 13));
    if (!v || typeof v !== 'object') continue;
    windows++;
    maxInFlight = Math.max(maxInFlight, +v.in_flight || 0);
    maxDelay = Math.max(maxDelay, +v.delay_max_ms || 0);
    for (const b of Array.isArray(v.busiest) ? v.busiest : []) {
      const k = `${b.method || ''} ${b.route || ''}`.trim();
      const r = routes.get(k) || { method: b.method || '', route: b.route || '', count: 0, total_ms: 0 };
      r.count += +b.count || 0; r.total_ms += +b.total_ms || 0;
      routes.set(k, r);
    }
    for (const st of Array.isArray(v.stalls) ? v.stalls : []) for (const n of Array.isArray(st.running) ? st.running : []) running.set(n, (running.get(n) || 0) + 1);
  }
  return { windows, maxInFlight, maxDelay, routes: [...routes.values()].sort((a, b) => b.total_ms - a.total_ms || b.count - a.count),
    stalls: [...running.entries()].sort((a, b) => b[1] - a[1]).map(([name, times]) => ({ name, times })) };
}

// Gateway access log, one JSON object a line (Caddy `log { format json }`). Requests at or after `since` (ms).
export function parseAccessLog(text, since = 0) {
  const rows = new Map(), perRoute = new Map();
  let total = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    const v = json(line);
    const req = v?.request;
    if (!req) continue;
    const at = typeof v.ts === 'number' ? v.ts * 1000 : Date.parse(v.ts || '') || 0;
    if (at && at < since) continue;
    const h = req.headers || {};
    const head = n => { const x = h[n] ?? h[n.toLowerCase()]; return Array.isArray(x) ? x[0] : x; };
    const ua = head('User-Agent') || '';
    const who = head('X-Wizard-Device') || req.client_ip || req.remote_ip || '';
    const method = req.method || '', route = routeOf(req.uri);
    const key = `${who}\n${method} ${route}`;
    const r = rows.get(key) || { device: tag(who), kind: deviceKind(ua), method, route, count: 0, first: at, last: at };
    r.count++; r.first = Math.min(r.first || at, at); r.last = Math.max(r.last, at);
    rows.set(key, r);
    perRoute.set(`${method} ${route}`, (perRoute.get(`${method} ${route}`) || 0) + 1);
    total++;
  }
  return { total, rows: [...rows.values()].sort((a, b) => b.count - a.count), perRoute };
}

const per = n => Math.round(n * 10) / 10;
// The cause, from the strongest evidence first. kind: client-loop (one device, one route), route-storm (one route,
// device unknown), update (the first outage began right after an update), unknown.
export function nameCause({ loop, access, release, firstStart, now = Date.now() }) {
  const top = access?.rows?.[0];
  if (top) {
    const span = Math.max(60, (top.last - top.first) / 1000);
    const rate = top.count / span, share = top.count / (access.perRoute.get(`${top.method} ${top.route}`) || top.count);
    if (rate >= LOOP_RATE && share >= LOOP_SHARE) return { kind: 'client-loop', device: top.device, deviceKind: top.kind, method: top.method, route: top.route, rate: per(rate), share: Math.round(share * 100), count: top.count };
  }
  const busiest = loop?.routes?.[0];
  if (busiest && loop.windows) {
    const all = loop.routes.reduce((n, r) => n + r.count, 0);
    const rate = busiest.count / (loop.windows * 60);
    if (rate >= LOOP_RATE && busiest.count / all >= 0.5) return { kind: 'route-storm', method: busiest.method, route: busiest.route, rate: per(rate), share: Math.round(busiest.count / all * 100), count: busiest.count };
  }
  if (release?.changedAt && firstStart && release.changedAt <= firstStart && firstStart - release.changedAt < UPDATE_WINDOW && now - release.changedAt < UPDATE_WINDOW * 2)
    return { kind: 'update', release: release.target, minutesAfter: Math.round((firstStart - release.changedAt) / 60e3) };
  return { kind: 'unknown' };
}
export const causeKey = c => c.kind === 'update' ? `update:${c.release}` : `${c.kind}:${c.method} ${c.route}`;

// The Agent Service is already limiting this route (wizard-agent-service#513 `client_storm` in /wizard/health).
export function limitActive(health, cause) {
  const raw = health?.client_storm ?? health?.client_storms ?? health?.limits?.client_storm;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return list.some(x => x && (!cause?.route || !x.route || routeOf(x.route) === cause.route));
}
export async function agentHealth() {
  const r = await httpGet({ port: CONFIG.agentPort, path: '/wizard/health', timeout: 5000 });
  return json(r.body) || null;
}

// The one plain status the owner sees until the fix is live.
export function causeText(c, { limiting = false, rolledBack = false, filed = false } = {}) {
  const fix = filed ? 'a fix is being built' : 'Wizard is asking for a fix';
  if (c.kind === 'client-loop') return `A ${c.deviceKind} is resending one request in a loop (about ${c.rate} a second); ${limiting ? 'Wizard is limiting it' : 'Wizard restarts what it freezes until it stops'}; ${fix}.`;
  if (c.kind === 'route-storm') return `One request is being sent over and over (about ${c.rate} a second); ${limiting ? 'Wizard is limiting it' : 'Wizard restarts what it freezes until it stops'}; ${fix}.`;
  if (c.kind === 'update') return `This started right after the last Wizard update; ${rolledBack ? 'Wizard undid that update' : 'Wizard could not undo that update'}; ${fix}.`;
  return '';
}

// The hotfix the builder gets. A client loop is the client's bug (the Wizard shell is the client on every device:
// wizard-ux#1428 was the 13 Nov loop); a bad update is the Agent Service's. GUARDIAN_HOTFIX_REPO overrides both.
export function hotfixIssue(c, { loop, outages = [], containment = '' } = {}) {
  const repo = process.env.GUARDIAN_HOTFIX_REPO || (c.kind === 'update' ? 'wizard-agent-service' : 'wizard-ux');
  const times = outages.map(t => new Date(t).toISOString().slice(11, 16)).join(', ');
  const routes = (loop?.routes || []).slice(0, 5).map(r => `| ${r.method} ${r.route} | ${r.count} | ${Math.round(r.total_ms)} |`);
  const ev = [
    `Outages of the same check in the last 2 hours (UTC): ${times || 'n/a'}. Each restart only brought Wizard back for a while.`,
    c.kind === 'client-loop' ? `Gateway access log: one ${c.deviceKind} (tag ${c.device}) sent \`${c.method} ${c.route}\` ${c.count} times, about ${c.rate} a second, ${c.share}% of that route's requests.` : '',
    c.kind === 'route-storm' ? `\`${c.method} ${c.route}\` ran ${c.count} times in the slow event-loop windows, about ${c.rate} a second, ${c.share}% of the requests named there.` : '',
    c.kind === 'update' ? `The first outage began ${c.minutesAfter} min after Agent Service release \`${c.release}\` was installed.` : '',
    loop?.windows ? `\`[event-loop]\` journal: ${loop.windows} slow windows, up to ${loop.maxInFlight} requests in flight, longest delay ${Math.round(loop.maxDelay)} ms.\n\n| route | count | loop ms |\n|---|---|---|\n${routes.join('\n')}` : '',
    loop?.stalls?.length ? `Running during stalls: ${loop.stalls.slice(0, 5).map(s => `\`${s.name}\` (${s.times}x)`).join(', ')}.` : '',
    containment ? `Containment on the box: ${containment}.` : '',
  ].filter(Boolean).join('\n\n');
  const what = c.kind === 'update' ? `Wizard keeps freezing since Agent Service release ${c.release}`
    : `${c.kind === 'client-loop' ? `A ${c.deviceKind}` : 'A client'} resends ${c.method} ${c.route} in a loop and freezes Wizard`;
  return { repo, title: `Hotfix: ${what}`.slice(0, 200), body: [
    `**What happens:** ${causeText(c, { filed: true })} The same outage came back ${outages.length || 2} times in 2 hours; restarts did not fix it.`,
    `**What should happen:** ${c.kind === 'update' ? 'The update works without freezing Wizard.' : 'The client sends this request once per change, never in a loop.'}`,
    `**How to see it (this box's own evidence):**\n\n${ev}`,
    'Filed automatically by the Wizard Troubleshooter (wizard-troubleshooter#47). Please treat it as a hotfix.',
  ].join('\n\n').slice(0, 7900) };
}

// Box-local logs for the last `since` ms. GUARDIAN_EVENT_LOOP_LOG names a file instead of the journal (tests,
// rehearsals); GUARDIAN_ACCESS_LOG is the gateway's JSON access log, if the box keeps one.
const tail = (file, bytes = 4 << 20) => {
  try { const fd = fs.openSync(file, 'r'); const { size } = fs.fstatSync(fd); const len = Math.min(size, bytes); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd); return b.toString('utf8'); } catch { return ''; }
};
export async function gatherEvidence(since) {
  let loopText = '';
  if (process.env.GUARDIAN_EVENT_LOOP_LOG) loopText = tail(process.env.GUARDIAN_EVENT_LOOP_LOG);
  else if (CONFIG.agentContainer) { const r = await run(CONFIG.docker, ['logs', '--since', new Date(since).toISOString(), CONFIG.agentContainer], { timeout: 15000 }); loopText = `${r.out}\n${r.err}`; }
  else if (CONFIG.agentUnit) loopText = (await run('journalctl', ['--user', '-u', CONFIG.agentUnit, '--since', `@${Math.floor(since / 1000)}`, '--no-pager', '-o', 'cat', '-g', '\\[event-loop\\]', '-n', '400'], { timeout: 15000 })).out;
  const access = process.env.GUARDIAN_ACCESS_LOG ? parseAccessLog(tail(process.env.GUARDIAN_ACCESS_LOG), since) : null;
  return { loop: parseEventLoop(loopText), access };
}

// The Tracker on this box (GUARDIAN_TRACKER_URL, else its registry entry's loopback address).
export function trackerUrl() {
  if (process.env.GUARDIAN_TRACKER_URL !== undefined) return process.env.GUARDIAN_TRACKER_URL.replace(/\/$/, '');
  try {
    const reg = JSON.parse(fs.readFileSync(launcherFiles().apps, 'utf8'));
    const a = (reg.apps || []).find(x => ['wizardos-tracker', 'wizard-os-tracker'].includes(x?.id));
    const local = String(a?.view?.local || '');
    return /^http:\/\/127\.0\.0\.1:\d{2,5}/.test(local) ? local.match(/^http:\/\/127\.0\.0\.1:\d{2,5}/)[0] : '';
  } catch { return ''; }
}
export function trackerCall(name, args, base = trackerUrl()) {
  return new Promise(resolve => {
    if (!base) return resolve({ error: 'No WizardOS Tracker on this box.' });
    let u; try { u = new URL(base + '/mcp'); } catch { return resolve({ error: 'Bad tracker address.' }); }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => {
        const r = json(b)?.result;
        if (!r || r.isError) return resolve({ error: r?.content?.[0]?.text || `HTTP ${res.statusCode}` });
        resolve({ value: r.structuredContent || json(r.content?.[0]?.text) || {} });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', e => resolve({ error: e.message }));
    req.end(body);
  });
}
export async function fileHotfix(issue) {
  const r = await trackerCall('board_report_bug', issue);
  if (r.error) return { ok: false, error: r.error };
  const url = r.value.url || '';
  const m = url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
  return { ok: true, url, ref: r.value.id || (m ? `${m[1]}#${m[2]}` : '') };
}
// Is the filed fix live? A bug's fix is merged switched on and handed back as ready-to-test; closed is done.
export async function fixLive(ref) {
  if (!ref) return false;
  const r = await trackerCall('board_get', { issue: ref });
  if (r.error) return false;
  const labels = (r.value.labels || []).map(l => String(l?.name ?? l).toLowerCase());
  return String(r.value.state || '').toLowerCase() === 'closed' || labels.includes('ready-to-test');
}

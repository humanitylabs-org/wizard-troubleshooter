// #47 (switch recurring-cause): an outage that keeps coming back gets its cause named from the box's own evidence,
// is contained inside Wizard, and one hotfix is filed, instead of restart after restart. Fixture: the 13 Nov 2026
// incident (a phone sending PUT /wizard/thread-seen about 8 times a second; outages 03:25, 03:58, 05:25, 06:03 UTC).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
process.env.TROUBLESHOOT_STATE ||= fs.mkdtempSync((process.env.TMPDIR || os.tmpdir()) + '/rc-');
const C = await import('../lib/outage-cause.mjs');
const SW = await import('../lib/switches.mjs');
const MIN = 60e3;

const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Wizard';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15';
function accessLog(end, { seconds = 300, perSecond = 8 } = {}) {
  const lines = [];
  const row = (t, ip, ua, method, uri) => JSON.stringify({ level: 'info', ts: t / 1000, logger: 'http.log.access', request: { remote_ip: ip, client_ip: ip, method, uri, headers: { 'User-Agent': [ua] } }, status: 200 });
  for (let i = 0; i < seconds * perSecond; i++) lines.push(row(end - seconds * 1000 + i * (1000 / perSecond), '100.64.0.7', PHONE, 'PUT', '/wizard/thread-seen'));
  for (let i = 0; i < seconds / 10; i++) {
    lines.push(row(end - seconds * 1000 + i * 10000, '100.64.0.9', MAC, 'GET', '/wizard/v1/sessions?limit=50'));
    lines.push(row(end - seconds * 1000 + i * 10000 + 5, '100.64.0.9', MAC, 'PUT', '/wizard/thread-seen'));
  }
  return lines.join('\n') + '\n';
}
const loopLine = (inFlight, n) => `Nov 13 06:22:01 box node[1234]: [event-loop] ${JSON.stringify({ window_ms: 60000, delay_p99_ms: 2400, delay_max_ms: 5200, utilization: 0.98, in_flight: inFlight,
  busiest: [{ method: 'PUT', route: '/wizard/thread-seen', count: n, total_ms: 41000 }, { method: 'GET', route: '/wizard/v1/sessions', count: 12, total_ms: 3100 }],
  stalls: [{ blocked_ms: 1800, running: ['PUT /wizard/thread-seen'] }] })}`;
const LOOP = [loopLine(230, 480), loopLine(190, 470), 'some other log line'].join('\n');

test('the 13 Nov evidence names a phone resending one request in a loop', () => {
  const now = Date.now();
  const access = C.parseAccessLog(accessLog(now), now - 2 * 3600e3);
  const loop = C.parseEventLoop(LOOP);
  assert.equal(loop.windows, 2);
  assert.equal(loop.maxInFlight, 230);
  assert.equal(loop.routes[0].route, '/wizard/thread-seen');
  const cause = C.nameCause({ loop, access, release: null, firstStart: now - 40 * MIN, now });
  assert.equal(cause.kind, 'client-loop');
  assert.equal(cause.deviceKind, 'phone');
  assert.equal(cause.route, '/wizard/thread-seen');
  assert.ok(cause.rate >= 7 && cause.rate <= 8.5, String(cause.rate));
  assert.equal(C.causeText(cause, { limiting: true, filed: true }), `A phone is resending one request in a loop (about ${cause.rate} a second); Wizard is limiting it; a fix is being built.`);
  const issue = C.hotfixIssue(cause, { loop, outages: [now - 40 * MIN, now - 5 * MIN], containment: 'the Agent Service limits it' });
  assert.equal(issue.repo, 'wizard-ux');
  assert.match(issue.title, /^Hotfix: A phone resends PUT \/wizard\/thread-seen in a loop/);
  assert.doesNotMatch(issue.body, /100\.64\.|127\.0\.0\.1|iPhone OS/, 'no device address or raw user agent in the issue');
  assert.match(issue.body, /230 requests in flight/);
});

test('without an access log the journal alone names the route; without either, a fresh update is the suspect', () => {
  const now = Date.now();
  const storm = C.nameCause({ loop: C.parseEventLoop(LOOP), access: null, release: null, firstStart: now, now });
  assert.equal(storm.kind, 'route-storm');
  assert.match(C.causeText(storm), /^One request is being sent over and over/);
  const upd = C.nameCause({ loop: C.parseEventLoop(''), access: null, release: { target: 'r42', changedAt: now - 50 * MIN }, firstStart: now - 30 * MIN, now });
  assert.deepEqual(upd, { kind: 'update', release: 'r42', minutesAfter: 20 });
  assert.equal(C.hotfixIssue(upd).repo, 'wizard-agent-service');
  assert.equal(C.nameCause({ loop: C.parseEventLoop(''), access: null, release: { target: 'r41', changedAt: now - 9 * 3600e3 }, firstStart: now - 30 * MIN, now }).kind, 'unknown');
  // Normal use (a person tapping now and then) is no loop.
  assert.equal(C.nameCause({ loop: null, access: C.parseAccessLog(accessLog(now, { perSecond: 0.2 })), release: null, firstStart: now, now }).kind, 'unknown');
});

test('the Agent Service limit counts only when it covers the looping route', () => {
  const cause = { kind: 'client-loop', route: '/wizard/thread-seen' };
  assert.equal(C.limitActive({ client_storm: [{ device: 'x', route: '/wizard/thread-seen', rate: 8 }] }, cause), true);
  assert.equal(C.limitActive({ client_storm: { route: '/wizard/other' } }, cause), false);
  assert.equal(C.limitActive({ status: 'ok' }, cause), false);
  assert.equal(C.limitActive(null, cause), false);
});

test('the switch is off by default, linked to #47, and flips on the box', () => {
  const l = SW.listing();
  assert.equal(l.contract, 'wizard.app-switches/1');
  const sw = l.switches.find(s => s.id === 'recurring-cause');
  assert.equal(sw.on, false);
  assert.equal(sw.default, false);
  assert.deepEqual(sw.issues, ['humanitylabs-org/wizard-troubleshooter#47']);
  assert.equal(SW.setSwitch('recurring-cause', true).switches[0].on, true);
  assert.equal(SW.switchOn('recurring-cause'), true);
  SW.setSwitch('recurring-cause', false);
  assert.throws(() => SW.setSwitch('nope', true));
});

// ---- the fixture storm, through the real guardian ----
const listen = handler => new Promise(r => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
async function closedPort() { const s = await listen(() => {}); const { port } = s.address(); await new Promise(r => s.close(r)); return port; }
async function storm(t, { on = true, dry = false } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rc-storm-'));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'access.log'), accessLog(now));
  fs.writeFileSync(path.join(dir, 'event-loop.log'), LOOP);
  if (on) fs.writeFileSync(path.join(dir, 'switches.json'), JSON.stringify({ 'recurring-cause': true }));
  // The Agent Service froze again (503), and its per-device limit reports the storm (wizard-agent-service#513).
  const agent = await listen((req, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'degraded', client_storm: [{ device: 'd1', route: '/wizard/thread-seen', rate: 8, body_bytes: 117000 }] })); });
  const filed = [];
  const tracker = await listen((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      const m = JSON.parse(b); filed.push(m.params);
      const n = 900 + filed.length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { isError: false, content: [], structuredContent: { id: `humanitylabs-org/wizard-ux#${n}`, url: `https://github.com/humanitylabs-org/wizard-ux/issues/${n}`, state: 'open', labels: ['bug'] } } }));
    });
  });
  t.after(() => { agent.close(); tracker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const closed = await closedPort();
  const env = { PATH: process.env.PATH, HOME: dir, TROUBLESHOOT_STATE: dir, WAS_RELEASE_ROOT: path.join(dir, 'releases'), AGENT_PORT: String(agent.address().port),
    AGENT_HEALTH_TIMEOUT_MS: '1500', AGENT_UNIT: 'fake-agent.service', HERMES_PORT: String(closed), HERMES_UNIT: '', GATEWAY_PORT: String(closed), GATEWAY_UNIT: '', TAILSCALE_UNIT: '',
    SHELL_PORT: String(closed), SHELL_CONTAINER: '', RUN_KEEPER_UNIT: '', AUTH_PORT: '0', TS_SOCKET: path.join(dir, 'no.sock'), GUARDIAN_THREAD: '', TROUBLESHOOT_PORT: String(closed),
    GUARDIAN_ACCESS_LOG: path.join(dir, 'access.log'), GUARDIAN_EVENT_LOOP_LOG: path.join(dir, 'event-loop.log'), GUARDIAN_TRACKER_URL: `http://127.0.0.1:${tracker.address().port}`, APP_ADDRESSES: '0' };
  const minute = async state => {
    fs.writeFileSync(path.join(dir, 'guardian.json'), JSON.stringify(state));
    const child = spawn(process.execPath, ['bin/guardian.mjs', ...(dry ? ['--dry-run'] : [])], { cwd: path.resolve(import.meta.dirname, '..'), env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    assert.equal(await new Promise(r => child.on('close', r)), 0, err);
    return { out, saved: JSON.parse(fs.readFileSync(path.join(dir, 'guardian.json'), 'utf8')) };
  };
  const incidents = () => fs.readFileSync(path.join(dir, 'incidents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  // Earlier outages of the Agent Service 35 min ago; it has failed long enough now that a restart would be due.
  const base = { fails: { 'agent-service': 5 }, fixes: {}, outage: null, lastAiRepair: now, rolledBack: {}, outageStarts: { 'agent-service': [now - 35 * MIN] } };
  return { minute, incidents, filed, base, dir };
}

test('fixture storm, switch on: one incident, a containment action and one filed bug, not repeated restarts', async t => {
  const { minute, incidents, filed, base } = await storm(t);
  const first = await minute(base);
  // The storm comes back after the next recovery: same cause, so no second bug.
  const fails = { 'agent-service': 5 };
  const again = await minute({ ...first.saved, outage: null, fails, outageStarts: { 'agent-service': [Date.now() - 20 * MIN, ...first.saved.outageStarts['agent-service']] } });
  const inc = incidents();
  assert.equal(inc.filter(i => i.kind === 'auto-fix' || (i.kind === 'auto-fix-result' && /restart/.test(i.action || ''))).length, 0, 'no restart: the limit contains it');
  assert.equal(filed.length, 1, 'one bug filed');
  assert.equal(filed[0].name, 'board_report_bug');
  assert.equal(filed[0].arguments.repo, 'wizard-ux');
  assert.match(filed[0].arguments.title, /^Hotfix: A phone resends PUT \/wizard\/thread-seen in a loop/);
  const causes = inc.filter(i => i.kind === 'cause-found');
  assert.equal(causes.length, 2);
  assert.match(causes[0].text, /^A phone is resending one request in a loop \(about [\d.]+ a second\); Wizard is limiting it; a fix is being built\.$/);
  assert.match(causes[0].containment, /limits PUT \/wizard\/thread-seen per device/);
  assert.equal(inc.filter(i => i.kind === 'hotfix-filed').length, 1);
  assert.equal(first.saved.restartHold['agent-service'].contained, 'client-loop:PUT /wizard/thread-seen');
  assert.equal(again.saved.knownCause.issue, 'humanitylabs-org/wizard-ux#901');
  assert.equal(again.saved.knownCause.since, first.saved.knownCause.since, 'the same cause keeps its one status');
});

test('fixture storm, switch off (the default): nothing new happens', async t => {
  const { minute, incidents, filed, base } = await storm(t, { on: false, dry: true });
  const { out, saved } = await minute(base);
  assert.equal(filed.length, 0);
  assert.equal(incidents().filter(i => i.kind === 'cause-found').length, 0);
  assert.equal(saved.knownCause, undefined);
  assert.match(out, /would restart:agent-service/, 'the restart path is unchanged');
});

test('fixture storm, report-only: says what it would do and files nothing', async t => {
  const { minute, filed, base } = await storm(t, { dry: true });
  const { out } = await minute(base);
  assert.equal(filed.length, 0);
  assert.match(out, /would hold restarts/);
  assert.match(out, /would file wizard-ux: Hotfix: A phone resends/);
});

// ---- the switch endpoint (wizard.app-switches/1) and the page's one status ----
test('GET/POST /troubleshoot/api/switches flips the switch; the page shows the named cause only while it is on', async t => {
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rc-http-'));
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(TROUBLESHOOT_|GUARDIAN_|WAS_|TS_|TAILSCALE_|GATEWAY_|AUTH_|SHELL_|AGENT_|HERMES_|CLAUDE_|CHATGPT_|TINFOIL_|WIZARD_|DOCKER_)/.test(k)) delete base[k];
  const closed = await closedPort();
  const env = { ...base, HOME: state, TROUBLESHOOT_STATE: state, TROUBLESHOOT_DEV_NO_AUTH: '1', TS_SOCKET: path.join(state, 'no.sock'), WAS_RELEASE_ROOT: path.join(state, 'releases'),
    CLAUDE_CONFIG_DIR: path.join(state, 'no-claude'), CLAUDE_BIN: '/bin/false', CHATGPT_AUTH_FILE: path.join(state, 'none.json'), TINFOIL_URL: 'http://127.0.0.1:9',
    TINFOIL_TOKEN_FILE: path.join(state, 'none.json'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '', AUTH_PORT: '', DOCKER_BIN: '/bin/false', AGENT_PORT: String(closed), HERMES_PORT: String(closed),
    GATEWAY_PORT: String(closed), SHELL_PORT: String(closed), AGENT_HEALTH_TIMEOUT_MS: '400' };
  fs.writeFileSync(path.join(state, 'guardian.json'), JSON.stringify({ knownCause: { key: 'k', text: 'A phone is resending one request in a loop (about 8 a second); Wizard is limiting it; a fix is being built.', since: Date.now(), issue: 'humanitylabs-org/wizard-ux#901' } }));
  let child, port;
  for (let attempt = 0; attempt < 5 && !child; attempt++) {
    port = 20000 + Math.floor(Math.random() * 20000);
    const c = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const up = await new Promise(resolve => { let out = ''; const tm = setTimeout(() => resolve(false), 5000); c.stdout.on('data', d => { out += d; if (out.includes(`:${port}/troubleshoot`)) { clearTimeout(tm); resolve(true); } }); c.on('exit', () => { clearTimeout(tm); resolve(false); }); });
    if (up) child = c; else c.kill();
  }
  t.after(() => { child.kill(); fs.rmSync(state, { recursive: true, force: true }); });
  const call = (method, p, body, headers = {}) => fetch(`http://127.0.0.1:${port}/troubleshoot/api/${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) }).then(async r => [r.status, await r.json()]);
  let [code, l] = await call('GET', 'switches');
  assert.equal(code, 200);
  assert.equal(l.contract, 'wizard.app-switches/1');
  assert.deepEqual(l.switches.map(s => [s.id, s.on]), [['recurring-cause', false]]);
  assert.equal((await call('GET', 'status'))[1].knownCause, null, 'switch off: no status');
  assert.equal((await call('POST', 'switches', { id: 'recurring-cause', on: true }))[0], 403, 'a flip needs X-Wizard-Switch: 1 (or the page header)');
  [code, l] = await call('POST', 'switches', { id: 'recurring-cause', on: true }, { 'X-Wizard-Switch': '1' });
  assert.equal(code, 200);
  assert.equal(l.switches[0].on, true);
  const st = (await call('GET', 'status'))[1];
  assert.match(st.knownCause.text, /^A phone is resending one request in a loop/);
  assert.equal(st.knownCause.issue, 'humanitylabs-org/wizard-ux#901');
  assert.equal((await call('POST', 'switches', { id: 'nope', on: true }, { 'X-Wizard-Switch': '1' }))[0], 400);
});

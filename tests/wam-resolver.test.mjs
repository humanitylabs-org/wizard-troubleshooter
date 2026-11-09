// Every repair resolves the App Manager command the way the installed App Manager does: the code its API service runs,
// never a stale ~/.local/bin/wam. The 2 Nov 2026 break was an old wam copy republishing Messenger at a raw port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWam, runningSource } from '../lib/wam.mjs';
import { RAW, box, fakeWam } from './helpers-box.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const NEW = 1_800_000_000, OLD = 1_790_000_000; // seconds; the stale copy is older than the running App Manager

// A fake box home: the running App Manager (its API service unit points at it), a stale checkout, and the launchers.
function home({ unit = true } = {}) {
  const h = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'wam-resolve-'));
  const mk = name => { const d = path.join(h, name); fs.mkdirSync(path.join(d, 'wam'), { recursive: true }); return d; };
  const current = mk('app-manager-current'), stale = mk('app-manager-old');
  for (const [d, t] of [[current, NEW], [stale, OLD]]) { const f = path.join(d, 'wam/cli.py'); fs.writeFileSync(f, '# wam'); fs.utimesSync(f, t, t); }
  fs.mkdirSync(path.join(h, '.config/systemd/user'), { recursive: true });
  if (unit) fs.writeFileSync(path.join(h, '.config/systemd/user/wizard-app-manager-api.service'), `[Service]\nWorkingDirectory=${current}\nExecStart=/usr/bin/python3 -m wam serve\n`);
  fs.mkdirSync(path.join(h, '.local/bin'), { recursive: true });
  const launcher = (file, src) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `#!/usr/bin/env bash\nexport X=1\ncd "${src}" && exec python3 -m wam "$@"\n`); fs.chmodSync(file, 0o755); return file; };
  return { h, current, stale, launcher, canonical: path.join(h, '.local/bin/wam'), env: { PATH: '' } };
}

test('the running App Manager is found from its API service unit (and its drop-ins)', () => {
  const t = home();
  assert.equal(runningSource(t.env, t.h), t.current);
  const d = path.join(t.h, '.config/systemd/user/wizard-app-manager-api.service.d');
  fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'x.conf'), `[Service]\nWorkingDirectory=${t.stale}\n`);
  assert.equal(runningSource(t.env, t.h), t.stale, 'a drop-in overrides the unit, as in systemd');
  assert.equal(runningSource({ WAM_RUNNING_SOURCE: '/x' }, t.h), '/x');
});

test('the current App Manager command is preferred over a stale ~/.local/bin/wam', () => {
  const t = home();
  t.launcher(t.canonical, t.stale);                                  // the stale copy that caused the 2 Nov break
  const current = t.launcher(path.join(t.current, 'bin/wam'), t.current);
  const r = resolveWam(t.env, t.h);
  assert.equal(r.ok, true);
  assert.equal(r.bin, current);
});

test('the installed command is used when it runs the same code as the running App Manager', () => {
  const t = home();
  t.launcher(t.canonical, t.current);
  const r = resolveWam(t.env, t.h);
  assert.deepEqual([r.ok, r.bin], [true, t.canonical]);
});

test('a command from a newer checkout than the running one is not stale', () => {
  const t = home();
  const newer = path.join(t.h, 'newer'); fs.mkdirSync(path.join(newer, 'wam'), { recursive: true });
  fs.writeFileSync(path.join(newer, 'wam/cli.py'), '#'); fs.utimesSync(path.join(newer, 'wam/cli.py'), NEW + 500, NEW + 500);
  t.launcher(t.canonical, newer);
  assert.equal(resolveWam(t.env, t.h).ok, true);
});

test('only a stale copy found: refuse, in plain words, and name the command', () => {
  const t = home();
  t.launcher(t.canonical, t.stale);
  const r = resolveWam(t.env, t.h);
  assert.equal(r.ok, false);
  assert.equal(r.bin, '');
  assert.match(r.reason, new RegExp(`${t.canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is older than the running App Manager, so the repair was not run`));
  assert.match(r.reason, /Update the App Manager/);
});

test('a frozen builder-bundle copy is never used', () => {
  const t = home();
  fs.writeFileSync(t.canonical, '#!/bin/sh\n# wizard-builder-bundle-v1\nexec true\n'); fs.chmodSync(t.canonical, 0o755);
  const r = resolveWam(t.env, t.h);
  assert.equal(r.ok, false);
  assert.match(r.reason, /frozen builder copy/);
});

test('WAM_BIN is honoured as is, even next to a stale copy; a missing WAM_BIN refuses', () => {
  const t = home();
  t.launcher(t.canonical, t.stale);
  const mine = t.launcher(path.join(t.h, 'mine/wam'), t.stale);
  const r = resolveWam({ ...t.env, WAM_BIN: mine }, t.h);
  assert.deepEqual([r.ok, r.bin, r.via], [true, mine, 'WAM_BIN']);
  const gone = resolveWam({ ...t.env, WAM_BIN: path.join(t.h, 'nope') }, t.h);
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /WAM_BIN/);
});

test('no running App Manager to compare with: the installed command is accepted; none at all refuses', () => {
  const t = home({ unit: false });
  assert.match(resolveWam(t.env, t.h).reason, /No App Manager command/);
  t.launcher(t.canonical, t.stale);
  assert.deepEqual([resolveWam(t.env, t.h).ok, resolveWam(t.env, t.h).bin], [true, t.canonical]);
});

// ---- end to end: the repair and the guardian with a stale copy on a box with a running App Manager ----

function staleBox() {
  const t = home();
  const b = box({ links: RAW, apps: RAW, shared: RAW });
  fs.mkdirSync(b.state, { recursive: true });
  fs.writeFileSync(path.join(b.state, 'launchers.json'), JSON.stringify({ paths: { messenger: '/messenger/' } }));
  const env = { PATH: '/usr/bin:/bin', HOME: t.h, WIZARD_OS_HOME: b.home, RUNTIPI_ROOT: b.runtipi, TROUBLESHOOT_STATE: b.state };
  return { t, b, env, staleCalls: path.join(b.dir, 'stale-calls'), currentCalls: path.join(b.dir, 'current-calls') };
}
// The stale copy: ~/.local/bin/wam launching the old checkout; it records every time it is spawned.
const stale = s => { fs.writeFileSync(s.t.canonical, `#!/bin/sh\necho stale >> "${s.staleCalls}"\ncd "${s.t.stale}" && exit 0\n`); fs.chmodSync(s.t.canonical, 0o755); };
const incidents = b => fs.readFileSync(path.join(b.state, 'incidents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('repair script: with the current App Manager alongside and a stale canonical copy, only the current one runs', () => {
  const s = staleBox();
  stale(s);
  fs.mkdirSync(path.join(s.t.current, 'bin'), { recursive: true });
  fakeWam(s.b, true, { file: path.join(s.t.current, 'bin/wam'), log: s.currentCalls });
  const p = spawnSync(process.execPath, ['bin/repair-app-addresses.mjs'], { cwd: ROOT, env: s.env, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr + p.stdout);
  assert.equal(fs.existsSync(s.staleCalls), false, 'the stale copy was spawned');
  assert.equal(fs.readFileSync(s.currentCalls, 'utf8'), 'links --json\n');
  for (const f of [s.b.files.apps, s.b.files.shared]) assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).apps[0].view.url, '/messenger/');
});

test('repair script: only a stale copy exists, so it refuses, logs a plain-words incident, and changes nothing', () => {
  const s = staleBox();
  stale(s);
  const before = [s.b.files.links, s.b.files.apps, s.b.files.shared].map(f => fs.readFileSync(f));
  const p = spawnSync(process.execPath, ['bin/repair-app-addresses.mjs'], { cwd: ROOT, env: s.env, encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.match(p.stderr, /older than the running App Manager/);
  assert.equal(fs.existsSync(s.staleCalls), false);
  [s.b.files.links, s.b.files.apps, s.b.files.shared].forEach((f, i) => assert.ok(fs.readFileSync(f).equals(before[i])));
  const e = incidents(s.b).find(x => x.kind === 'repair-refused');
  assert.match(e.text, /^App addresses were not repaired\. The App Manager command at .* is older than the running App Manager/);
  assert.equal(fs.existsSync(path.join(s.b.state, 'launcher-backups')), false);
});

test('an app-managed Agent Service gets no restart through a stale copy', () => {
  const s = staleBox();
  stale(s);
  const script = "import {ACTIONS,CONFIG} from './lib/checks.mjs';console.log(JSON.stringify({a:ACTIONS['restart:agent-service']||null,wam:CONFIG.wam,why:CONFIG.wamRefusal}))";
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env: { ...s.env, AGENT_UNIT: '', AGENT_CONTAINER: 'agent-1' }, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const o = JSON.parse(p.stdout);
  assert.equal(o.a, null);
  assert.equal(o.wam, '');
  assert.match(o.why, /older than the running App Manager/);
});

test('guardian with automatic repairs on and only a stale copy: the repair is refused with an incident, wam never spawned', () => {
  const s = staleBox();
  stale(s);
  const env = { ...s.env, GUARDIAN_ACT: '1', TS_SOCKET: path.join(s.b.dir, 'no.sock'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '', GATEWAY_MODE: 'tailscale-serve', GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: '1', AUTH_PORT: '', SHELL_PORT: '1', SHELL_CONTAINER: '', AGENT_PORT: '1', AGENT_UNIT: '', AGENT_CONTAINER: '', HERMES_PORT: '1', HERMES_UNIT: '',
    WAS_RELEASE_ROOT: path.join(s.b.dir, 'none'), WAS_DEPLOY_BIN: path.join(s.b.dir, 'none') };
  const before = [s.b.files.links, s.b.files.apps, s.b.files.shared].map(f => fs.readFileSync(f));
  for (let i = 0; i < 3; i++) { const g = spawnSync(process.execPath, ['bin/guardian.mjs'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 }); assert.equal(g.status, 0, g.stderr); }
  assert.equal(fs.existsSync(s.staleCalls), false);
  [s.b.files.links, s.b.files.apps, s.b.files.shared].forEach((f, i) => assert.ok(fs.readFileSync(f).equals(before[i])));
  assert.ok(incidents(s.b).some(e => e.kind === 'repair-refused' && /older than the running App Manager/.test(e.text)));
});

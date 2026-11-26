import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect, backup } from '../lib/launchers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = 'https://box.tail1234.ts.net:9245/';
const app = (id, url, status = 'running') => ({ id, name: id[0].toUpperCase() + id.slice(1), status, view: { url, local: 'http://127.0.0.1:9245/' } });

function box({ links = '/messenger/', apps = '/messenger/', shared = apps, extra = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'app-addr-'));
  const home = path.join(dir, 'wizard-os'), runtipi = path.join(dir, 'runtipi');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(runtipi, 'app-data', 'wizard-os'), { recursive: true });
  const files = { home, links: path.join(home, 'links.json'), apps: path.join(home, 'apps.json'),
    shared: path.join(runtipi, 'app-data', 'wizard-os', 'apps.json'), lock: path.join(home, '.links.lock') };
  fs.writeFileSync(files.links, JSON.stringify({ links: [{ id: 'messenger', open: links, url: RAW }, { id: 'files', open: '/files/' }], errors: {} }));
  fs.writeFileSync(files.apps, JSON.stringify({ apps: [app('messenger', apps), app('files', '/files/'), ...extra] }));
  fs.writeFileSync(files.shared, JSON.stringify({ apps: [app('messenger', shared), app('files', '/files/'), ...extra] }));
  return { dir, home, runtipi, files, state: path.join(dir, 'state') };
}

test('healthy addresses pass and are remembered', () => {
  const b = box();
  const r = inspect(b.files, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.remembered, { messenger: '/messenger/', files: '/files/' });
});

test('links.json still on the Wizard path but apps.json on a raw port is caught', () => {
  const r = inspect(box({ apps: RAW, shared: RAW }).files, {});
  assert.equal(r.ok, false);
  assert.match(r.detail, /Messenger opens at https:\/\/box\.tail1234\.ts\.net:9245\/ instead of \/messenger\//);
});

test('the 2 Nov downgrade (links.json AND apps.json rewritten to the raw port) is caught from memory', () => {
  const b = box({ links: RAW, apps: RAW, shared: RAW });
  assert.equal(inspect(b.files, {}).ok, true);                         // nothing to compare without memory
  const r = inspect(b.files, { messenger: '/messenger/' });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);                                   // the owner's copy and the shared copy
  assert.equal(r.remembered.messenger, '/messenger/');                  // a wrong address is never learned
});

test('only the shared copy the Agent Service reads is wrong: still caught', () => {
  const r = inspect(box({ shared: RAW }).files, {});
  assert.equal(r.ok, false);
  assert.ok(r.problems.every(p => p.file.includes('app-data')));
});

test('stopped and uninstalled apps are left alone', () => {
  const b = box({ apps: 'http://127.0.0.1:9245/', shared: 'http://127.0.0.1:9245/' });
  for (const f of [b.files.apps, b.files.shared]) {
    const reg = JSON.parse(fs.readFileSync(f, 'utf8'));
    reg.apps[0].status = 'stopped';
    fs.writeFileSync(f, JSON.stringify(reg));
  }
  assert.equal(inspect(b.files, {}).ok, true);
  const r = inspect(b.files, { gone: '/gone/' });
  assert.equal(r.ok, true);
  assert.equal(r.remembered.gone, undefined);
});

test('backups keep the three files and only the latest 20', () => {
  const b = box({ apps: RAW });
  let last;
  for (let i = 0; i < 22; i++) last = backup(b.files, b.state, new Date(Date.UTC(2026, 10, 2, 8, 0, i)));
  assert.deepEqual(last.saved.sort(), ['apps.json', 'links.json', 'shared-apps.json']);
  assert.equal(fs.readdirSync(path.join(b.state, 'launcher-backups')).length, 20);
  assert.equal(JSON.parse(fs.readFileSync(path.join(last.dir, 'apps.json'), 'utf8')).apps[0].view.url, RAW);
  assert.equal(fs.statSync(path.join(last.dir, 'apps.json')).mode & 0o777, 0o600);
});

// A stand-in `wam links --json` that republishes the Wizard path (what the box's wam does) or fails to.
function fakeWam(b, fixes) {
  const f = path.join(b.dir, 'wam');
  const files = JSON.stringify([b.files.apps, b.files.shared]);
  fs.writeFileSync(f, `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(path.join(b.dir, 'wam-calls'))}, process.argv.slice(2).join(' ') + '\\n');
if (${fixes}) for (const p of ${files}) { const r = JSON.parse(fs.readFileSync(p, 'utf8')); r.apps[0].view.url = '/messenger/'; fs.writeFileSync(p, JSON.stringify(r)); }
console.log(JSON.stringify({ links: [], errors: ${fixes} ? {} : { messenger: 'kept /messenger/: existing Serve route differs' } }));
process.exit(${fixes} ? 0 : 1);
`);
  fs.chmodSync(f, 0o755);
  return f;
}

const envFor = (b, wam, extra = {}) => ({ PATH: process.env.PATH, HOME: b.dir, WIZARD_OS_HOME: b.home, RUNTIPI_ROOT: b.runtipi,
  TROUBLESHOOT_STATE: b.state, WAM_BIN: wam, ...extra });

test('repair backs up, runs the box wam links, reads the address back and logs it', () => {
  const b = box({ links: RAW, apps: RAW, shared: RAW });
  fs.mkdirSync(b.state, { recursive: true });
  fs.writeFileSync(path.join(b.state, 'launchers.json'), JSON.stringify({ paths: { messenger: '/messenger/' } }));
  const p = spawnSync(process.execPath, ['bin/repair-app-addresses.mjs'], { cwd: ROOT, env: envFor(b, fakeWam(b, true)), encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr + p.stdout);
  assert.equal(fs.readFileSync(path.join(b.dir, 'wam-calls'), 'utf8'), 'links --json\n');
  for (const f of [b.files.apps, b.files.shared]) assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).apps[0].view.url, '/messenger/');
  const [bak] = fs.readdirSync(path.join(b.state, 'launcher-backups'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.state, 'launcher-backups', bak, 'apps.json'), 'utf8')).apps[0].view.url, RAW);
  const log = fs.readFileSync(path.join(b.state, 'incidents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const e = log.find(x => x.kind === 'app-addresses-repair');
  assert.equal(e.ok, true);
  assert.deepEqual(e.before[0], { id: 'messenger', want: '/messenger/', got: RAW });
});

test('a repair that does not bring the address back says so and exits non-zero', () => {
  const b = box({ apps: RAW, shared: RAW });
  const p = spawnSync(process.execPath, ['bin/repair-app-addresses.mjs'], { cwd: ROOT, env: envFor(b, fakeWam(b, false)), encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.match(p.stdout, /Still wrong/);
  const e = fs.readFileSync(path.join(b.state, 'incidents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(x => x.kind === 'app-addresses-repair');
  assert.equal(e.ok, false);
  assert.match(e.wamErrors.messenger, /differs/);
});

test('nothing wrong: the repair touches nothing', () => {
  const b = box();
  const p = spawnSync(process.execPath, ['bin/repair-app-addresses.mjs'], { cwd: ROOT, env: envFor(b, fakeWam(b, true)), encoding: 'utf8' });
  assert.equal(p.status, 0);
  assert.equal(fs.existsSync(path.join(b.dir, 'wam-calls')), false);
});

test('the guardian heals a downgraded address within two runs, even in report-only mode', () => {
  const b = box();
  const wam = fakeWam(b, true);
  // Every other link points at nothing on this test box (they fail fast and, report-only, are never acted on).
  const env = envFor(b, wam, { GUARDIAN_ACT: '0', TS_SOCKET: path.join(b.dir, 'no.sock'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '',
    GATEWAY_MODE: 'tailscale-serve', GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '1', AUTH_PORT: '', SHELL_PORT: '1', SHELL_CONTAINER: '',
    AGENT_PORT: '1', AGENT_UNIT: '', AGENT_CONTAINER: '', HERMES_PORT: '1', HERMES_UNIT: '', WAS_RELEASE_ROOT: path.join(b.dir, 'none'),
    WAS_DEPLOY_BIN: path.join(b.dir, 'none') });
  const guard = () => spawnSync(process.execPath, ['bin/guardian.mjs'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  let g = guard();                                                       // learns /messenger/ while healthy
  assert.equal(g.status, 0, g.stderr);
  for (const f of [b.files.links, b.files.apps, b.files.shared]) {      // an old wam copy rewrites all three
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('"/messenger/"', JSON.stringify(RAW)));
  }
  g = guard();
  assert.equal(JSON.parse(g.stdout.trim().split('\n').pop()).actions.length, 0);   // one sighting: no action yet
  g = guard();
  const out = JSON.parse(g.stdout.trim().split('\n').pop());
  assert.deepEqual(out.actions, ['restart:app-addresses:true'], g.stdout + g.stderr);
  for (const f of [b.files.apps, b.files.shared]) assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).apps[0].view.url, '/messenger/');
  const kinds = fs.readFileSync(path.join(b.state, 'incidents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).kind);
  assert.ok(kinds.includes('auto-fix') && kinds.includes('app-addresses-repair') && kinds.includes('auto-fix-result'));
  // GUARDIAN_HEAL_ADDRESSES=0 keeps report-only strictly report-only
  for (const f of [b.files.apps, b.files.shared]) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('"/messenger/"', JSON.stringify(RAW)));
  env.GUARDIAN_HEAL_ADDRESSES = '0';
  guard(); g = guard();
  assert.equal(JSON.parse(g.stdout.trim().split('\n').pop()).actions.length, 0);
});

// #68/#69 (25 Nov 2026): during the Money→Finances rename the registry said `/` for six minutes; the check remembered
// it and flagged the correct `/money/` for 19 hours, a false alarm `wam links` could never clear.
test('a remembered `/` never beats the registered path: it passes and re-learns the registry', () => {
  const b = box({ extra: [app('finances', '/money/')] });
  const r = inspect(b.files, { finances: '/', messenger: '/messenger/' });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.remembered.finances, '/money/');
});

test('a rename from one Wizard path to another is learned at once, with no problem', () => {
  const b = box({ links: '/messenger/', apps: '/chat/', shared: '/chat/' });
  const r = inspect(b.files, { messenger: '/messenger/' });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.remembered.messenger, '/chat/');
});

test('`/` and a path another app is registered at are never learned as an app address', () => {
  const b = box({ links: '/', apps: '/', shared: '/', extra: [app('notes', '/files/')] });
  const r = inspect(b.files, {});
  assert.equal(r.ok, true);
  assert.equal(r.remembered.messenger, undefined, 'the Wizard shell is not an app address');
  assert.equal(r.remembered.files, undefined, 'two apps on /files/: neither owns it');
  assert.equal(r.remembered.notes, undefined);
});

// #69 ask 3: `wam links` ran cleanly (exit 0, no errors) and left the address where it was. Retrying can't change it,
// so the remembered address may be stale: say so, stop repairing, and never count it as an outage.
function cleanNoopWam(b) {
  const f = path.join(b.dir, 'wam-noop');
  fs.writeFileSync(f, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(path.join(b.dir, 'wam-calls'))}, process.argv.slice(2).join(' ') + '\\n');
console.log(JSON.stringify({ links: [], errors: {} }));
`);
  fs.chmodSync(f, 0o755);
  return f;
}

test('a clean `wam links` that leaves the address unchanged: the memory may be stale, no outage, no more repairs', () => {
  const b = box({ apps: RAW, shared: RAW });
  fs.mkdirSync(b.state, { recursive: true });
  fs.writeFileSync(path.join(b.state, 'launchers.json'), JSON.stringify({ paths: { messenger: '/messenger/' } }));
  const env = envFor(b, cleanNoopWam(b));
  let p = spawnSync(process.execPath, ['bin/repair-app-addresses.mjs'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr + p.stdout);
  assert.match(p.stdout, /may be stale/);
  const saved = JSON.parse(fs.readFileSync(path.join(b.state, 'launchers.json'), 'utf8'));
  assert.deepEqual(saved.settled, { messenger: RAW });
  const e = fs.readFileSync(path.join(b.state, 'incidents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(x => x.kind === 'app-addresses-stale');
  assert.match(e.text, /remembered address may be stale for Messenger/);
  assert.match(e.text, /not an outage/);
  // The check now passes and says why; a second repair has nothing to do and does not run wam again.
  const r = inspect(b.files, saved.paths, saved.settled);
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /may be stale for Messenger/);
  p = spawnSync(process.execPath, ['bin/repair-app-addresses.mjs'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(p.status, 0);
  assert.equal(fs.readFileSync(path.join(b.dir, 'wam-calls'), 'utf8'), 'links --json\n');
  // A different move later (another raw port) is a new problem again, and the old note is dropped.
  const RAW2 = 'https://box.tail1234.ts.net:9999/';
  for (const f of [b.files.apps, b.files.shared]) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll(RAW, RAW2));
  const r2 = inspect(b.files, saved.paths, saved.settled);
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.settled, {});
});

test('a `wam links` that changes nothing but reports errors is still a failed repair (not settled)', () => {
  const b = box({ apps: RAW, shared: RAW });
  const p = spawnSync(process.execPath, ['bin/repair-app-addresses.mjs'], { cwd: ROOT, env: envFor(b, fakeWam(b, false)), encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.state, 'launchers.json'), 'utf8')).settled, undefined);
});

test('the guardian stops repairing once a clean `wam links` left the address as it was', () => {
  const b = box();
  const env = envFor(b, cleanNoopWam(b), { GUARDIAN_ACT: '0', TS_SOCKET: path.join(b.dir, 'no.sock'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '',
    GATEWAY_MODE: 'tailscale-serve', GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '1', AUTH_PORT: '', SHELL_PORT: '1', SHELL_CONTAINER: '',
    AGENT_PORT: '1', AGENT_UNIT: '', AGENT_CONTAINER: '', HERMES_PORT: '1', HERMES_UNIT: '', WAS_RELEASE_ROOT: path.join(b.dir, 'none'),
    WAS_DEPLOY_BIN: path.join(b.dir, 'none') });
  const guard = () => spawnSync(process.execPath, ['bin/guardian.mjs'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  let g = guard();                                                       // learns /messenger/ while healthy
  assert.equal(g.status, 0, g.stderr);
  for (const f of [b.files.links, b.files.apps, b.files.shared]) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('"/messenger/"', JSON.stringify(RAW)));
  guard(); g = guard();
  assert.deepEqual(JSON.parse(g.stdout.trim().split('\n').pop()).actions, ['restart:app-addresses:true'], g.stdout + g.stderr);
  for (let i = 0; i < 3; i++) { g = guard(); assert.equal(JSON.parse(g.stdout.trim().split('\n').pop()).actions.length, 0, g.stdout); }
  assert.equal(fs.readFileSync(path.join(b.dir, 'wam-calls'), 'utf8'), 'links --json\n', 'one clean wam links, then no more repairs');
});

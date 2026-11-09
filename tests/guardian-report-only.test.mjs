// GUARDIAN_ACT=0 is a promise: the guardian reports and changes nothing (docs/REPAIR_KIT.md, spec/MAINTENANCE.md,
// DECISIONS #91). The app-address repair rewrites links.json and both apps.json copies, so it follows that promise
// unless the owner explicitly sets GUARDIAN_HEAL_ADDRESSES=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RAW, box, fakeWam, envFor } from './helpers-box.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = f => fs.readFileSync(f);
const incidents = b => { try { return fs.readFileSync(path.join(b.state, 'incidents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };

// A box whose other links point at nothing (they fail fast; no unit or container exists to restart). `extra` sets the
// guardian mode. The first guardian run learns /messenger/ while healthy, then an old wam copy "rewrites" all three files.
function brokenBox(extra) {
  const b = box();
  const wam = fakeWam(b, true);
  const env = envFor(b, wam, { TS_SOCKET: path.join(b.dir, 'no.sock'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '',
    GATEWAY_MODE: 'tailscale-serve', GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '1', AUTH_PORT: '', SHELL_PORT: '1', SHELL_CONTAINER: '',
    AGENT_PORT: '1', AGENT_UNIT: '', AGENT_CONTAINER: '', HERMES_PORT: '1', HERMES_UNIT: '', WAS_RELEASE_ROOT: path.join(b.dir, 'none'),
    WAS_DEPLOY_BIN: path.join(b.dir, 'none'), ...extra });
  const guard = () => spawnSync(process.execPath, ['bin/guardian.mjs'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  const g = guard();
  assert.equal(g.status, 0, g.stderr);
  for (const f of [b.files.links, b.files.apps, b.files.shared]) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('"/messenger/"', JSON.stringify(RAW)));
  return { b, guard, wamCalls: path.join(b.dir, 'wam-calls') };
}
const fixed = b => [b.files.apps, b.files.shared].every(f => JSON.parse(fs.readFileSync(f, 'utf8')).apps[0].view.url === '/messenger/');

test('report-only (GUARDIAN_ACT=0, no GUARDIAN_HEAL_ADDRESSES): a broken address is reported as "would fix" and nothing is touched', () => {
  const { b, guard, wamCalls } = brokenBox({ GUARDIAN_ACT: '0' });
  const before = [b.files.links, b.files.apps, b.files.shared].map(read);
  for (let i = 0; i < 4; i++) guard();                                            // well past the 2-failure threshold
  [b.files.links, b.files.apps, b.files.shared].forEach((f, i) => assert.ok(read(f).equals(before[i]), `${path.basename(f)} changed`));
  assert.equal(fs.existsSync(wamCalls), false, 'wam must never be spawned in report-only mode');
  assert.equal(fs.existsSync(path.join(b.state, 'launcher-backups')), false, 'no backup/repair ran');
  const would = incidents(b).filter(e => e.kind === 'would-fix' && e.action === 'restart:app-addresses');
  assert.equal(would.length, 1);
  assert.match(would[0].text, /Report-only: Apps open inside Wizard wasn't working .*Messenger opens at .*9245.*would repair it/);
  assert.match(would[0].text, /Nothing was changed/);
  assert.ok(!incidents(b).some(e => ['auto-fix', 'app-addresses-repair', 'auto-fix-result'].includes(e.kind)));
});

test('report-only with GUARDIAN_HEAL_ADDRESSES=1: the owner opted in, so the address is healed', () => {
  const { b, guard, wamCalls } = brokenBox({ GUARDIAN_ACT: '0', GUARDIAN_HEAL_ADDRESSES: '1' });
  guard(); guard();
  assert.ok(fixed(b));
  assert.equal(fs.readFileSync(wamCalls, 'utf8'), 'links --json\n');
  assert.ok(incidents(b).some(e => e.kind === 'app-addresses-repair' && e.ok));
});

test('report-only with GUARDIAN_HEAL_ADDRESSES=0 or any other value than 1 stays report-only', () => {
  for (const v of ['0', '', 'yes']) {
    const { b, guard, wamCalls } = brokenBox({ GUARDIAN_ACT: '0', GUARDIAN_HEAL_ADDRESSES: v });
    guard(); guard();
    assert.equal(fixed(b), false, `HEAL=${JSON.stringify(v)}`);
    assert.equal(fs.existsSync(wamCalls), false);
  }
});

test('--dry-run never heals, even with GUARDIAN_HEAL_ADDRESSES=1', () => {
  const { b, wamCalls } = brokenBox({ GUARDIAN_ACT: '0', GUARDIAN_HEAL_ADDRESSES: '1' });
  const env = { ...envFor(b, path.join(b.dir, 'wam')), GUARDIAN_ACT: '0', GUARDIAN_HEAL_ADDRESSES: '1', TS_SOCKET: path.join(b.dir, 'no.sock'), TAILSCALE_UNIT: '', GATEWAY_UNIT: '',
    GATEWAY_MODE: 'tailscale-serve', GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '1', AUTH_PORT: '', SHELL_PORT: '1', SHELL_CONTAINER: '', AGENT_PORT: '1', AGENT_UNIT: '', AGENT_CONTAINER: '',
    HERMES_PORT: '1', HERMES_UNIT: '', WAS_RELEASE_ROOT: path.join(b.dir, 'none'), WAS_DEPLOY_BIN: path.join(b.dir, 'none') };
  for (let i = 0; i < 3; i++) spawnSync(process.execPath, ['bin/guardian.mjs', '--dry-run'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(fixed(b), false);
  assert.equal(fs.existsSync(wamCalls), false);
});

test('automatic repairs on (GUARDIAN_ACT=1): the address is healed as before', () => {
  const { b, guard, wamCalls } = brokenBox({ GUARDIAN_ACT: '1' });
  guard(); const g = guard();
  assert.deepEqual(JSON.parse(g.stdout.trim().split('\n').pop()).actions, ['restart:app-addresses:true'], g.stdout + g.stderr);
  assert.ok(fixed(b));
  assert.equal(fs.readFileSync(wamCalls, 'utf8'), 'links --json\n');
});

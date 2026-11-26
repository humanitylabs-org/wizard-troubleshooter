#!/usr/bin/env node
// Repair app addresses (the `restart:app-addresses` one-tap fix and the guardian's automatic repair).
// An app that opens inside Wizard at its own path lost that address in apps.json (lib/launchers.mjs). Back up the
// files App Manager rewrites, run the box's own `wam links --json` (which republishes every app page and keeps an
// owner's gateway route), then read the addresses back. Exit 0 only when every app is back on its path.
import fs from 'node:fs';
import { CONFIG, logIncident, run } from '../lib/checks.mjs';
import { backup, inspect, launcherFiles, loadRemembered, loadSettled, saveRemembered } from '../lib/launchers.mjs';

const files = launcherFiles();
const remembered = loadRemembered(CONFIG.stateDir);
const before = inspect(files, remembered, loadSettled(CONFIG.stateDir));
if (before.ok) { console.log(before.detail); process.exit(0); }
if (!fs.existsSync(CONFIG.wam)) { console.error(`App Manager command not found (${CONFIG.wam}).`); process.exit(1); }
// A link refresh is running right now (it holds this lock): it writes the same files, so let it finish.
if (fs.existsSync(files.lock) && !(await run('flock', ['-n', files.lock, 'true'], { timeout: 3000 })).ok) {
  console.error('App Manager is publishing app addresses right now; checking again next minute.');
  process.exit(1);
}
const saved = backup(files, CONFIG.stateDir);
const r = await run(CONFIG.wam, ['links', '--json'], { timeout: 300000 });
let after = inspect(files, before.remembered, before.settled);
let refreshErrors = {};
try { refreshErrors = JSON.parse(r.out).errors || {}; } catch {}
// #69: `wam links` ran cleanly (exit 0, no errors) and left the same apps at the same addresses. It is the box's own
// authority on app addresses, so retrying or restarting can't change them: the remembered address may be stale.
// Note them as settled (the check reports them, never as an outage) instead of failing every hour.
const key = ps => JSON.stringify([...new Set(ps.map(p => `${p.id}\n${p.got}`))].sort());
const unchanged = !after.ok && r.code === 0 && !Object.keys(refreshErrors).length && key(after.problems) === key(before.problems);
if (unchanged) {
  const settled = { ...before.settled };
  for (const p of after.problems) settled[p.id] = p.got;
  after = inspect(files, before.remembered, settled);
  saveRemembered(CONFIG.stateDir, after.remembered, after.settled);
  const names = [...new Set(before.problems.map(p => p.name))].join(', ');
  logIncident({
    kind: 'app-addresses-stale', ok: after.ok, backup: saved.dir, wamExit: r.code,
    stale: before.problems.filter((p, i, a) => a.findIndex(q => q.id === p.id) === i).map(p => ({ id: p.id, want: p.want, got: p.got })),
    text: `The remembered address may be stale for ${names}: \`wam links\` ran cleanly and keeps it at ${before.problems[0].got || 'no address'}, so Wizard stops repairing it (not an outage).`,
  });
  console.log(`Not an outage: \`wam links\` ran cleanly and keeps ${names} at ${before.problems[0].got || 'no address'}; the remembered address may be stale. Backup: ${saved.dir}`);
  process.exit(after.ok ? 0 : 1);
}
saveRemembered(CONFIG.stateDir, after.remembered, after.settled);
logIncident({
  kind: 'app-addresses-repair', ok: after.ok, backup: saved.dir,
  before: before.problems.map(p => ({ id: p.id, want: p.want, got: p.got })),
  after: after.problems.map(p => ({ id: p.id, want: p.want, got: p.got })),
  wamExit: r.code, wamErrors: Object.fromEntries(Object.entries(refreshErrors).map(([k, v]) => [k, String(v).slice(0, 200)])),
  text: after.ok
    ? `App addresses repaired: ${[...new Set(before.problems.map(p => p.name))].join(', ')} open inside Wizard again (backup ${saved.dir}).`
    : `App addresses still wrong after \`wam links\`: ${after.detail}`,
});
console.log(after.ok ? `Repaired: ${before.detail.replace(/\.$/, '')} -> now at the Wizard path. Backup: ${saved.dir}` : `Still wrong: ${after.detail} Backup: ${saved.dir}`);
process.exit(after.ok ? 0 : 1);

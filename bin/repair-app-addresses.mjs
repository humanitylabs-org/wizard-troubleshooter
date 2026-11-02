#!/usr/bin/env node
// Repair app addresses (the `restart:app-addresses` one-tap fix and the guardian's automatic repair).
// An app that opens inside Wizard at its own path lost that address in apps.json (lib/launchers.mjs). Back up the
// files App Manager rewrites, run the box's own `wam links --json` (which republishes every app page and keeps an
// owner's gateway route), then read the addresses back. Exit 0 only when every app is back on its path.
import fs from 'node:fs';
import { CONFIG, logIncident, run } from '../lib/checks.mjs';
import { backup, inspect, launcherFiles, loadRemembered, saveRemembered } from '../lib/launchers.mjs';

const files = launcherFiles();
const remembered = loadRemembered(CONFIG.stateDir);
const before = inspect(files, remembered);
if (before.ok) { console.log(before.detail); process.exit(0); }
if (!fs.existsSync(CONFIG.wam)) { console.error(`App Manager command not found (${CONFIG.wam}).`); process.exit(1); }
// A link refresh is running right now (it holds this lock): it writes the same files, so let it finish.
if (fs.existsSync(files.lock) && !(await run('flock', ['-n', files.lock, 'true'], { timeout: 3000 })).ok) {
  console.error('App Manager is publishing app addresses right now; checking again next minute.');
  process.exit(1);
}
const saved = backup(files, CONFIG.stateDir);
const r = await run(CONFIG.wam, ['links', '--json'], { timeout: 300000 });
const after = inspect(files, before.remembered);
saveRemembered(CONFIG.stateDir, after.remembered);
let refreshErrors = {};
try { refreshErrors = JSON.parse(r.out).errors || {}; } catch {}
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

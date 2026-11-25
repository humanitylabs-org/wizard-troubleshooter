// Owner feature switches (wizard.app-switches/1, wizard-os docs/APP_SWITCHES.md). Every new feature ships behind one,
// off by default, linked to the issue it delivers so the WizardOS Tracker's Try it toggle can flip it. State lives on
// the box (<state>/switches.json), shared by the page server and the guardian timer, and is read on every call so a
// flip takes effect on the guardian's next minute without a restart. Served at GET/POST /troubleshoot/api/switches.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './checks.mjs';

export const CONTRACT = 'wizard.app-switches/1';
// No feature is behind a switch right now; the endpoint still serves the contract with an empty list.
export const SWITCHES = [];
// Switches whose feature is now on for everyone: a value a box still stores for them is cleared.
// recurring-cause (#47): approved at show-and-tell, the guardian names and contains repeat outages on every box.
const RETIRED = ['recurring-cause'];

const FILE = () => path.join(CONFIG.stateDir, 'switches.json');
function saved() {
  try { const v = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
// Clear stored values of retired switches, once per process (the page server and every guardian minute load this).
export function forgetRetired() {
  try {
    const v = saved();
    if (!RETIRED.some(id => id in v)) return;
    for (const id of RETIRED) delete v[id];
    fs.writeFileSync(FILE() + '.tmp', JSON.stringify(v, null, 1), { mode: 0o600 });
    fs.renameSync(FILE() + '.tmp', FILE());
  } catch {}
}
forgetRetired();
export function switchOn(id) {
  const def = SWITCHES.find(s => s.id === id);
  if (!def) return false;
  const v = saved()[id];
  return typeof v === 'boolean' ? v : def.default;
}
export function listing() {
  return { contract: CONTRACT, switches: SWITCHES.map(s => ({ ...s, on: switchOn(s.id) })) };
}
export function setSwitch(id, on) {
  if (!SWITCHES.some(s => s.id === id) || typeof on !== 'boolean') throw Object.assign(new Error('Unknown switch, or "on" is not true/false.'), { status: 400 });
  const next = { ...saved(), [id]: on };
  fs.writeFileSync(FILE() + '.tmp', JSON.stringify(next, null, 1), { mode: 0o600 });
  fs.renameSync(FILE() + '.tmp', FILE());
  return listing();
}

// Owner feature switches (wizard.app-switches/1, wizard-os docs/APP_SWITCHES.md). Every new feature ships behind one,
// off by default, linked to the issue it delivers so the WizardOS Tracker's Try it toggle can flip it. State lives on
// the box (<state>/switches.json), shared by the page server and the guardian timer, and is read on every call so a
// flip takes effect on the guardian's next minute without a restart. Served at GET/POST /troubleshoot/api/switches.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './checks.mjs';

export const CONTRACT = 'wizard.app-switches/1';
export const SWITCHES = [
  { id: 'recurring-cause', name: 'Name and contain outages that keep coming back',
    description: 'When the same outage comes back within 2 hours, the guardian names the cause from the box\'s own logs (a device resending one request in a loop, or the last update), limits it or undoes the update, files one hotfix for the builder, and shows you one plain status until the fix is live.',
    default: false, issues: ['humanitylabs-org/wizard-troubleshooter#47'] },
];

const FILE = () => path.join(CONFIG.stateDir, 'switches.json');
function saved() {
  try { const v = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
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

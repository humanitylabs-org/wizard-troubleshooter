// Shared fixtures for the app-address tests: a throwaway box (links.json + both apps.json copies) and a stand-in `wam`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RAW = 'https://box.tail1234.ts.net:9245/';
export const app = (id, url, status = 'running') => ({ id, name: id[0].toUpperCase() + id.slice(1), status, view: { url, local: 'http://127.0.0.1:9245/' } });

export function box({ links = '/messenger/', apps = '/messenger/', shared = apps, extra = [] } = {}) {
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

// A stand-in `wam links --json` that republishes the Wizard path (what the box's wam does) or fails to.
export function fakeWam(b, fixes, { file = path.join(b.dir, 'wam'), log = path.join(b.dir, 'wam-calls') } = {}) {
  const f = file;
  const files = JSON.stringify([b.files.apps, b.files.shared]);
  fs.writeFileSync(f, `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
if (${fixes}) for (const p of ${files}) { const r = JSON.parse(fs.readFileSync(p, 'utf8')); r.apps[0].view.url = '/messenger/'; fs.writeFileSync(p, JSON.stringify(r)); }
console.log(JSON.stringify({ links: [], errors: ${fixes} ? {} : { messenger: 'kept /messenger/: existing Serve route differs' } }));
process.exit(${fixes} ? 0 : 1);
`);
  fs.chmodSync(f, 0o755);
  return f;
}

export const envFor = (b, wam, extra = {}) => ({ PATH: process.env.PATH, HOME: b.dir, WIZARD_OS_HOME: b.home, RUNTIPI_ROOT: b.runtipi,
  TROUBLESHOOT_STATE: b.state, WAM_BIN: wam, ...extra });


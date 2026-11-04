// Local administrative command target. Never accepts model argv or executes shell.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
// The owning user's home and runtime dir, never a hard-coded account (works on any Wizard box).
const home = os.userInfo().homedir;
const uid = process.getuid();
const units = ['wizard-store-data.service', 'wizard-app-manager-api.service', 'wizard-ui-prefs.service', 'wizard-system-resources.service'];
const action = process.argv[2];
const unit = process.argv[3];
const run = (exe,args) => execFileSync(exe,args,{encoding:'utf8',timeout:20000,maxBuffer:256*1024,env:{PATH:'/usr/bin:/bin',HOME:home,XDG_RUNTIME_DIR:`/run/user/${uid}`,DBUS_SESSION_BUS_ADDRESS:`unix:path=/run/user/${uid}/bus`,LANG:'C.UTF-8'}}).trim();
function fence() {
  if (fs.existsSync(home+'/.wizard-os/standby.lock')) throw Error('Standby role fence: recovery disabled');
}
function regular(file) {
  let p=''; for(const n of file.split('/').filter(Boolean)){p+='/'+n;if(fs.lstatSync(p).isSymbolicLink())throw Error('Symlink path refused');}
  const s=fs.statSync(file);if(!s.isFile()||s.nlink!==1||s.size>1024*1024)throw Error('Invalid configuration file');
  return fs.readFileSync(file,'utf8');
}
try {
  if (action === 'validate-registry') {
    const p=home+'/.wizard-os/apps.json'; const data=JSON.parse(regular(p));
    const apps=Array.isArray(data)?data:(Array.isArray(data.apps)?data.apps:Object.values(data.apps||data));
    const ids=apps.map(a=>a.id).filter(Boolean);
    if(!ids.length||new Set(ids).size!==ids.length)throw Error('Registry has missing or duplicate app ids');
    console.log(JSON.stringify({ok:true,file:p,appCount:ids.length,uniqueIds:true,role:fs.existsSync(home+'/.wizard-os/standby.lock')?'standby':'active',note:'No registry contents, credentials or app environment disclosed'}));
  } else if(action === 'validate-recovery-config') {
    const p=home+'/.config/systemd/user/wizard-store-data.service.d/repair-delay.conf';
    const content=regular(p);if(!/^\[Service\]\nRestartSec=(?:[2-9]|[1-5][0-9]|60)\n$/.test(content))throw Error('Invalid bounded RestartSec configuration');
    console.log(JSON.stringify({ok:true,file:p,content,effective:run('/usr/bin/systemctl',['--user','show','wizard-store-data.service','--property=RestartUSec','--property=ActiveState'])}));
  } else if(action === 'daemon-reload') {
    fence();run('/usr/bin/systemctl',['--user','daemon-reload']);console.log('User service definitions reloaded; no services restarted.');
  } else if(action === 'restart' && units.includes(unit)) {
    fence();
    // All are existing auxiliary Wizard units. No network/auth/runtime/host-hop units.
    const loaded=run('/usr/bin/systemctl',['--user','show',unit,'--property=LoadState','--value']);
    if(loaded!=='loaded')throw Error('Unit is not installed');
    run('/usr/bin/systemctl',['--user','restart',unit]);
    console.log(run('/usr/bin/systemctl',['--user','show',unit,'--property=ActiveState','--property=SubState']));
  } else throw Error('Unknown fixed operational command');
} catch(e) {console.error(e.message);process.exitCode=1;}

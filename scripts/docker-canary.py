#!/usr/bin/env python3
"""Short, isolated Docker canary. No live routes, host mounts or real model credentials."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
D = ['docker', '--context', 'colima']
IMAGE = 'wizard-l3-troubleshooter:canary'
NATIVE = 'wizard-l3-troubleshooter-native-canary'
COMPOSE = D + ['compose', '-p', 'wizard-l3-troubleshooter-canary', '-f', str(ROOT / 'runtipi/docker-compose.yml')]

def run(args):
    p = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(p.stdout, end='')
    p.check_returncode()
    return p.stdout.strip()

probe = r'''
const base='http://127.0.0.1:9691/troubleshoot';
const check=(v,s)=>{if(!v)throw Error(s)};
for(let i=0;i<60;i++){try{await fetch(base+'/api/ping');break}catch{await new Promise(r=>setTimeout(r,100))}}
const ping=await (await fetch(base+'/api/ping')).json();
const ready=await fetch(base+'/api/readiness');
const blocked=await fetch(base+'/api/repair',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"message":"must not run"}'});
const rpc=await (await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recovery_readiness'}})})).json();
check(ping.ok&&ping.ready===false,'process/recovery distinction');
check(ready.status===503&&blocked.status===503,'host authority must fail closed');
check(JSON.parse(rpc.result.content[0].text).ready===false,'MCP readiness');
console.log(JSON.stringify({isolatedRecipe:{ping:200,ready:ready.status,repair:blocked.status,mcpReady:false}}));
'''
native = r'''
import fs from 'node:fs';
const fake='/state/fake-model';
const ack='SYNTHETIC MODEL ACK - NO HOST REPAIR PERFORMED';
const events=[{type:'system',subtype:'init',session_id:'synthetic'},{type:'assistant',message:{content:[{type:'text',text:ack}]}},{type:'result',session_id:'synthetic',is_error:false}];
fs.writeFileSync(fake,'#!/usr/local/bin/node\nconst events='+JSON.stringify(events)+';\nfor(const e of events)console.log(JSON.stringify(e));\n',{mode:0o700});
const base='http://127.0.0.1:9691/troubleshoot';
for(let i=0;i<60;i++){try{await fetch(base+'/api/ping');break}catch{await new Promise(r=>setTimeout(r,100))}}
const ping=await fetch(base+'/api/ping');
const health=await fetch(base+'/api/status');
if(ping.status!==200||health.status!==200)throw Error('native health transport');
const response=await fetch(base+'/api/repair',{method:'POST',headers:{'Content-Type':'application/json','X-Wizard-Troubleshoot':'1'},body:JSON.stringify({message:'Synthetic transport test only',engine:'claude'})});
if(response.status!==202)throw Error('chat not accepted');
const {id}=await response.json();
let result;
for(let i=0;i<100;i++){result=await (await fetch(base+'/api/repair/'+id)).json();if(!result.running)break;await new Promise(r=>setTimeout(r,100));}
if(result.running||!result.events.some(x=>x.text===ack))throw Error('fake chat reply missing: '+JSON.stringify(result));
console.log(JSON.stringify({nativeFakeTransport:{ping:ping.status,status:health.status,repair:response.status,complete:!result.running,syntheticReply:true,hostRepaired:false}}));
'''
try:
    run(D + ['build', '-t', IMAGE, '.'])
    run(COMPOSE + ['up', '-d'])
    cid = run(COMPOSE + ['ps', '-q', 'wizard-troubleshooter']).splitlines()[-1]
    run(D + ['exec', cid, 'node', '--input-type=module', '-e', probe])
    run(D + ['run', '-d', '--name', NATIVE, '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=64m,uid=1000,gid=1000', '--tmpfs', '/state:rw,nosuid,exec,size=64m,uid=1000,gid=1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '-e', 'TROUBLESHOOT_CONTAINER=0', '-e', 'TROUBLESHOOT_DEV_NO_AUTH=1', '-e', 'CLAUDE_BIN=/state/fake-model', IMAGE])
    run(D + ['exec', NATIVE, 'node', '--input-type=module', '-e', native])
    print(json.dumps({'result': 'PASS', 'freshBoxAccepted': False, 'realModelUsed': False, 'liveServicesChanged': False}))
finally:
    subprocess.run(COMPOSE + ['down', '--remove-orphans'], cwd=ROOT, check=False)
    subprocess.run(D + ['rm', '-f', NATIVE], check=False)

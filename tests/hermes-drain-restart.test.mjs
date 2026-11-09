// 9 Nov 2026, the owner's repair conversation: (1) the one-tap "Restart your agent (Hermes)" failed because the
// gateway unit refuses manual stop (RefuseManualStop=yes); the sanctioned path is Hermes's own drain restart,
// `hermes gateway restart`, run from outside the gateway. (2) While that drain ran, the repair chat told the owner
// his restart "didn't actually restart" because the PID and start time were unchanged; the new gateway came up
// 90 s later. Hermetic: fake `systemctl`, `systemd-run`, `journalctl` and `hermes`, a throwaway HOME, dummy ports.
// Nothing here touches a real unit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const APP = path.resolve(import.meta.dirname, '..');

async function serve(handler) { const s = http.createServer(handler); await new Promise(r => s.listen(0, '127.0.0.1', r)); return s; }
async function closedPort() { const s = await serve(() => {}); const { port } = s.address(); await new Promise(r => s.close(r)); return port; }

// A box: Hermes green on /health, the Agent Service reporting a reply Wizard gave up on (replies not starting).
async function rig({ queue = { replies_not_started: 0, replies_not_started_s: 0, replies_given_up_15m: 1 }, landAfterS = null } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hermes-drain-'));
  const HOME = path.join(root, 'home'), STATE = path.join(root, 'state'), BIN = path.join(root, 'bin'), F = path.join(root, 'fake');
  const HH = path.join(HOME, '.hermes'), HBIN = path.join(HH, 'hermes-agent/.hermes/bin');
  for (const d of [HOME, STATE, BIN, F, HBIN]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(F, 'mainpid'), '1111');
  const w = (f, s) => fs.writeFileSync(f, s, { mode: 0o755 });
  // systemctl: MainPID from a file; a manual restart of the gateway is refused like the real fenced unit.
  w(path.join(BIN, 'systemctl'), `#!/bin/bash
echo "$*" >> ${F}/systemctl.log
if [[ "$*" == *" restart "* || "$*" == *" stop "* ]]; then echo "Failed to restart fake-hermes.service: Operation refused, unit may be requested by dependency only (it is configured to refuse manual start/stop)." >&2; exit 1; fi
if [[ "$2" == show && "$3" == fake-hermes.service ]]; then echo "MainPID=$(cat ${F}/mainpid)"; echo "ExecMainStartTimestamp=$(cat ${F}/since 2>/dev/null || echo 'Sun 2026-11-08 14:18:10 UTC')"; exit 0; fi
if [[ "$2" == show ]]; then echo "ActiveState=active"; exit 0; fi
if [[ "$2" == status ]]; then echo "● $3"; echo "   Main PID: $(cat ${F}/mainpid) (python)"; exit 0; fi
exit 0
`);
  w(path.join(BIN, 'journalctl'), `#!/bin/bash
[[ "$*" == *runtime_draining* && -f ${F}/journal-draining ]] && [[ "$*" == *"_PID=$(cat ${F}/mainpid)"* ]] && echo "WARNING gateway.run: Watch notification not admitted: runtime_draining"
exit 0
`);
  w(path.join(BIN, 'systemd-run'), `#!/bin/bash
printf '%s\\n' "$@" > ${F}/systemd-run.args
envs=(); cwd=/
while [[ $# -gt 0 ]]; do case "$1" in --setenv=*) envs+=("\${1#--setenv=}");; --working-directory=*) cwd="\${1#--working-directory=}";; --*) ;; *) break;; esac; shift; done
cd "$cwd" && env -i "\${envs[@]}" "$@" </dev/null >/dev/null 2>&1 &
exit 0
`);
  // hermes: records how it was called, starts draining, and (when asked) lands a new process.
  w(path.join(HBIN, 'hermes'), `#!/bin/sh
printf '%s\\n' "$*" > ${F}/hermes.argv; pwd > ${F}/hermes.cwd; echo "$HERMES_HOME" > ${F}/hermes.home
echo '{"pid":1111,"gateway_state":"draining","restart_requested":true,"active_agents":2}' > ${HH}/gateway_state.json
${landAfterS === null ? 'sleep 10' : `sleep ${landAfterS}; echo 2222 > ${F}/mainpid; echo 'Mon 2026-11-09 08:03:53 UTC' > ${F}/since; echo '{"pid":2222,"gateway_state":"running","restart_requested":false}' > ${HH}/gateway_state.json`}
echo "gateway restarted"
`);
  const agent = await serve((req, res) => {
    if (req.url === '/wizard/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', upstream_reachable: true, queue: { active: 1, queued: 0, ...queue } })); }
    res.writeHead(302, { Location: '/' }); res.end();
  });
  const hermes = await serve((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok","version":"test"}'); });
  const closed = await closedPort();
  const env = { PATH: `${BIN}:${process.env.PATH}`, HOME, TROUBLESHOOT_STATE: STATE, WAS_RELEASE_ROOT: path.join(root, 'releases'), WAS_DEPLOY_BIN: path.join(root, 'no-deploy'),
    AGENT_PORT: String(agent.address().port), AGENT_HEALTH_TIMEOUT_MS: '1000', AGENT_UNIT: 'fake-agent.service', HERMES_PORT: String(hermes.address().port), HERMES_UNIT: 'fake-hermes.service',
    GATEWAY_PORT: String(closed), SHELL_PORT: String(closed), AUTH_PORT: '0', TS_SOCKET: path.join(root, 'no.sock'), DOCKER_BIN: '/bin/false', APP_ADDRESSES: '0',
    HERMES_RESTART_CONFIRM_MS: '4000', HERMES_RESTART_WAIT_MS: '8000' };
  return { root, HOME, HH, STATE, F, env, read: f => { try { return fs.readFileSync(path.join(F, f), 'utf8'); } catch { return ''; } }, close: () => { agent.close(); hermes.close(); } };
}
async function node(script, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: APP, env });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 0, err);
  return JSON.parse(out.trim().split('\n').pop());
}

test('restart:hermes is the drain restart from outside the gateway, never a fenced systemctl restart', async () => {
  const r = await rig();
  try {
    const { a, res } = await node(`import { ACTIONS, doAction } from './lib/checks.mjs'; const a = ACTIONS['restart:hermes']; const res = await doAction('restart:hermes'); console.log(JSON.stringify({ a, res }));`, r.env);
    assert.deepEqual(a.drain, [path.join(r.HH, 'hermes-agent/.hermes/bin/hermes'), 'gateway', 'restart', '--interrupt']);
    assert.equal(res.ok, true, res.detail);
    assert.equal(res.pending, true, 'a drain in progress is reported as in progress, not failed and not done');
    assert.match(res.detail, /Restart in progress: your agent \(Hermes\) is draining/);
    assert.equal(r.read('hermes.argv').trim(), 'gateway restart --interrupt');
    assert.equal(r.read('hermes.cwd').trim(), r.HH, 'runs from ~/.hermes');
    assert.equal(r.read('hermes.home').trim(), r.HH);
    assert.match(r.read('systemd-run.args'), /--unit=wizard-hermes-restart-/, 'its own transient unit, outside the gateway and this service');
    assert.doesNotMatch(r.read('systemctl.log'), / restart /, 'never systemctl restart of the fenced gateway');
    // Asked again while it drains: not asked twice.
    const again = await node(`import { doAction } from './lib/checks.mjs'; console.log(JSON.stringify(await doAction('restart:hermes')));`, r.env);
    assert.equal(again.already, true);
  } finally { r.close(); }
});

test('repair chat: with replies not starting and Hermes green, restart:hermes reaches the owner, drains, and is re-checked after it lands', async () => {
  const r = await rig({ landAfterS: 1 });
  try {
    const out = await node(`const { callTool } = await import('./lib/toolloop.mjs'); let asked = null;
      const fix = await callTool('run_fix', '{"action":"restart:hermes"}', { authorize: async q => { asked = q; return true; } });
      const status = await callTool('check_status', '{}'); console.log(JSON.stringify({ fix, asked, status }));`, r.env);
    assert.deepEqual(out.asked, { tool: 'run_fix', args: { action: 'restart:hermes' } }, 'the owner confirms; the green health check does not block it');
    assert.match(out.fix, /Restart your agent \(Hermes\): done\. Your agent \(Hermes\) restarted at 08:03 UTC\. New PID 2222 \(was 1111\)/);
    assert.match(out.fix, /After the fix: Your agent \(Hermes\) is working/);
    assert.doesNotMatch(out.fix, /failed|still failing/i);
    assert.match(out.status, /OK {3}hermes — .*restarted at 08:03 UTC/);
  } finally { r.close(); }
});

for (const [name, setup] of [
  ['the gateway state file says draining', r => fs.writeFileSync(path.join(r.HH, 'gateway_state.json'), JSON.stringify({ pid: 1111, gateway_state: 'draining', restart_requested: true, active_agents: 3, updated_at: new Date().toISOString() }))],
  ['only the journal says runtime_draining', r => fs.writeFileSync(path.join(r.F, 'journal-draining'), '1')],
]) {
  test(`a restart the owner started himself, still draining (${name}), is "in progress", never "didn't restart"`, async () => {
    const r = await rig();
    try {
      setup(r);
      const out = await node(`const { callTool } = await import('./lib/toolloop.mjs'); let asked = null;
        const status = await callTool('check_status', '{}');
        const svc = await callTool('service_status', '{"unit":"fake-hermes.service"}');
        const fix = await callTool('run_fix', '{"action":"restart:hermes"}', { authorize: async q => { asked = q; return true; } });
        console.log(JSON.stringify({ status, svc, fix, asked }));`, r.env);
      assert.match(out.status, /BUSY hermes — Your agent \(Hermes\): Restart in progress: your agent \(Hermes\) is draining/);
      assert.doesNotMatch(out.status, /FAIL hermes/);
      assert.match(out.status, /PID \(1111\) and start time .* stay the same: that is expected and is NOT a failed restart/);
      assert.match(out.svc, /Main PID: 1111[\s\S]*Troubleshooter note: Restart in progress[\s\S]*NOT a failed restart/);
      assert.match(out.fix, /^Not restarted again: Restart in progress/);
      assert.equal(out.asked, null, 'no second restart is offered while one drains');
      assert.equal(r.read('hermes.argv'), '', 'nothing was run');
    } finally { r.close(); }
  });
}

test('the guardian leaves a draining Hermes alone (busy, not an outage to restart)', async () => {
  const r = await rig({ queue: {} });
  try {
    fs.writeFileSync(path.join(r.HH, 'gateway_state.json'), JSON.stringify({ pid: 1111, gateway_state: 'draining', updated_at: new Date().toISOString() }));
    const child = spawn(process.execPath, ['bin/guardian.mjs', '--dry-run'], { cwd: APP, env: { ...r.env, GUARDIAN_THREAD: '', GUARDIAN_TZ: 'UTC' } });
    let out = ''; child.stdout.on('data', d => { out += d; });
    assert.equal(await new Promise(res => child.on('close', res)), 0);
    const summary = JSON.parse(out.trim().split('\n').pop());
    assert.ok(summary.busy.includes('hermes'), out);
    assert.doesNotMatch(out, /would restart:hermes/);
  } finally { r.close(); }
});

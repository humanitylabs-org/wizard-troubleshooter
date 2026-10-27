// Shared repair schemas/executor: Claude via MCP, ChatGPT/Tinfoil via the bounded loop below.
// No arbitrary shell: fixed health fixes, diagnostics, and exact policy-scoped file/argv operations.
// Writes/commands require owner approval. Tool output is capped and scrubbed of token-shaped strings.
import { runChecks, ACTIONS, CHECKS, CONFIG, doAction, run, logIncident } from './checks.mjs';
import { repairDefs, repairTool } from './repair-tools.mjs';
import { providerFailure } from './reply-health.mjs';

const MAX_STEPS = +(process.env.REPAIR_TOOL_STEPS || 12);
const OUT_CAP = 6000;
export const scrub = s => String(s ?? '')
  .replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, '[redacted token]')
  .replace(/\b(sk|tk|pk|rk|uk)-[A-Za-z0-9_-]{16,}/g, '[redacted key]')
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
  .replace(/(?<!"sha256":")\b[a-f0-9]{40,}\b/gi, '[redacted hex]')
  .replace(/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1[redacted]');
const cap = s => { s = scrub(s); return s.length > OUT_CAP ? s.slice(0, OUT_CAP) + `\n… (${s.length - OUT_CAP} more characters cut)` : s; };

const units = () => [...new Set(CHECKS.map(c => c.unit).filter(Boolean).concat(['wizard-troubleshooter.service', 'wizard-guardian.service', 'wizard-store-data.service', 'wizard-app-manager-api.service', 'wizard-ui-prefs.service', 'wizard-system-resources.service']))];
const containersNow = async () => (await run(CONFIG.docker, ['ps', '-a', '--format', '{{.Names}}'], { timeout: 15000 })).out.split('\n').filter(Boolean);

export function toolDefs() {
  const u = units();
  return [
    ...repairDefs(),
    { name: 'check_status', description: 'Run every Troubleshooter health check now (Tailscale, HTTPS front door, app screens, Agent Service, Hermes, disk, memory). Returns each link with ok/failing and a plain detail.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'run_fix', description: 'Run one of the fixed one-tap fixes. Only works for a link that is failing right now. Tell the owner what you are about to do first.', parameters: { type: 'object', properties: { action: { type: 'string', enum: Object.keys(ACTIONS) } }, required: ['action'], additionalProperties: false } },
    { name: 'service_status', description: 'Read-only: systemctl --user status for one Wizard unit.', parameters: { type: 'object', properties: { unit: { type: 'string', enum: u } }, required: ['unit'], additionalProperties: false } },
    { name: 'journal_tail', description: 'Read-only: the last lines of one Wizard unit\'s log (journalctl --user).', parameters: { type: 'object', properties: { unit: { type: 'string', enum: u }, lines: { type: 'integer', minimum: 10, maximum: 200 } }, required: ['unit'], additionalProperties: false } },
    { name: 'docker_ps', description: 'Read-only: every Docker container with its state (docker ps -a).', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'docker_logs', description: 'Read-only: the last lines of one container\'s log.', parameters: { type: 'object', properties: { container: { type: 'string' }, lines: { type: 'integer', minimum: 10, maximum: 200 } }, required: ['container'], additionalProperties: false } },
    { name: 'disk_usage', description: 'Read-only: free space per filesystem (df -h).', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'memory_usage', description: 'Read-only: memory and swap (free -m) plus the top memory users.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  ];
}

export async function callTool(name, rawArgs, ctx = {}) {
  let args = {};
  try { args = typeof rawArgs === 'string' ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : (rawArgs || {}); } catch { return 'Error: arguments were not valid JSON.'; }
  const def = toolDefs().find(t => t.name === name);
  if (!def) return `Error: unknown tool ${name}.`;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(def.parameters.properties, k)) || (def.parameters.required || []).some(k => !Object.hasOwn(args, k))) return 'Error: arguments do not match tool schema.';
  for (const [k, v] of Object.entries(args)) {
    const s = def.parameters.properties[k];
    if ((s.type === 'string' && typeof v !== 'string') || (s.type === 'integer' && !Number.isInteger(v))) return 'Error: arguments do not match tool schema.';
  }
  if (repairDefs().some(t => t.name === name)) return cap(await repairTool(name, args, ctx));
  const u = units();
  const lines = Math.max(10, Math.min(200, +args.lines || 60));
  switch (name) {
    case 'check_status': {
      const s = await runChecks({ repairEngineProbes: false });
      return cap(`Overall: ${s.overall} (${s.summary})\n` + s.checks.map(c => `${c.ok ? 'OK  ' : 'FAIL'} ${c.id} — ${c.label}: ${c.detail}${!c.ok && c.fixable ? ` [fix: restart:${c.id}]` : ''}`).join('\n'));
    }
    case 'run_fix': {
      const action = String(args.action || '');
      if (!ACTIONS[action]) return `Error: unknown fix. Available: ${Object.keys(ACTIONS).join(', ')}`;
      const target = action.split(':')[1];
      const now = (await runChecks({ repairEngineProbes: false })).checks.find(c => c.id === target);
      if (now?.ok) return `Refused: ${now.label} is working right now (${now.detail}), so it is not restarted.`;
      if (!ctx.authorize || !await ctx.authorize({ tool: name, args: { action } })) return 'Refused: owner approval denied, expired, or unavailable';
      logIncident({ kind: 'owner-action', action, by: `repair-chat:${ctx.engine || '?'}` });
      const r = await doAction(action);
      const after = (await runChecks({ repairEngineProbes: false })).checks.find(c => c.id === target);
      logIncident({ kind: 'owner-action-result', action, ok: r.ok, detail: r.detail });
      return cap(`${r.detail}\nAfter the fix: ${after ? `${after.label} ${after.ok ? 'is working' : 'is still failing'}: ${after.detail}` : 'no check for this link'}`);
    }
    case 'service_status': {
      if (!u.includes(args.unit)) return `Error: unit must be one of ${u.join(', ')}`;
      const r = await run('systemctl', ['--user', 'status', '--no-pager', '-n', '0', args.unit], { timeout: 15000 });
      return cap(r.out || r.err);
    }
    case 'journal_tail': {
      if (!u.includes(args.unit)) return `Error: unit must be one of ${u.join(', ')}`;
      const r = await run('journalctl', ['--user', '-u', args.unit, '-n', String(lines), '--no-pager', '-o', 'short-iso'], { timeout: 20000 });
      return cap(r.out || r.err || 'No log lines.');
    }
    case 'docker_ps': {
      const r = await run(CONFIG.docker, ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'], { timeout: 15000 });
      return cap(r.out || r.err);
    }
    case 'docker_logs': {
      const names = await containersNow();
      if (!names.includes(args.container)) return `Error: no container named that. Containers: ${names.join(', ')}`;
      const r = await run(CONFIG.docker, ['logs', '--tail', String(lines), args.container], { timeout: 20000 });
      return cap([r.out, r.err].filter(Boolean).join('\n') || 'No log lines.');
    }
    case 'disk_usage': {
      const r = await run('df', ['-h', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay'], { timeout: 15000 });
      return cap(r.out || r.err);
    }
    case 'memory_usage': {
      const a = await run('free', ['-m'], { timeout: 10000 });
      const b = await run('ps', ['-eo', 'rss,comm', '--sort=-rss', '--no-headers'], { timeout: 10000 });
      return cap(`${a.out}\n\nTop memory (KB, process):\n${b.out.split('\n').slice(0, 12).join('\n')}`);
    }
    default: return `Error: unknown tool ${name}.`;
  }
}

const toolLabel = (name, args) => {
  let a = {}; try { a = typeof args === 'string' ? JSON.parse(args || '{}') : (args || {}); } catch {}
  const what = a.action || a.unit || a.container || '';
  return { check_status: 'status checks', run_fix: `fix ${what}`, service_status: `service ${what}`, journal_tail: `log of ${what}`, docker_ps: 'containers', docker_logs: `log of ${what}`, disk_usage: 'disk space', memory_usage: 'memory' }[name] || name;
};

function compact(msgs) {
  // Keep the newest two tool results whole; cut older ones to their first lines.
  const idx = msgs.map((m, i) => (m.role === 'tool' || m.type === 'function_call_output') ? i : -1).filter(i => i >= 0);
  for (const i of idx.slice(0, -2)) {
    const m = msgs[i], key = m.role === 'tool' ? 'content' : 'output';
    if (typeof m[key] === 'string' && m[key].length > 600) m[key] = m[key].slice(0, 600) + '\n… (shortened)';
  }
}

// Runs one owner turn. `turn` is the provider adapter ({text, calls, replay}). Emits events through `emit`.
export async function runLoop({ engine, turnFn, instructions, history, message, emit, signal, authorize }) {
  const tools = toolDefs();
  const msgs = engine === 'chatgpt'
    ? [...history.map(h => h.role === 'owner' ? { role: 'user', content: [{ type: 'input_text', text: h.text }] } : { role: 'assistant', content: [{ type: 'output_text', text: h.text }] }), { role: 'user', content: [{ type: 'input_text', text: message }] }]
    : [...history.map(h => ({ role: h.role === 'owner' ? 'user' : 'assistant', content: h.text })), { role: 'user', content: message }];
  let said = false, acted = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) throw new Error('Stopped.');
    let r;
    try { r = await turnFn({ instructions, input: msgs, messages: msgs, tools, signal }); }
    catch (e) {
      if (signal?.aborted) throw e;
      if ((e.signin || step === 0) && (said || acted)) { emit({ type: 'note', text: 'The provider stopped partway. What it found is above; the repair will not run twice.' }); return { ok: false, said, acted, error: e.message, signin: !!e.signin }; }
      if (e.signin || step === 0) throw e;
      // A long diagnosis can outgrow what the endpoint accepts: shrink earlier tool output once and retry.
      compact(msgs);
      try { r = await turnFn({ instructions, input: msgs, messages: msgs, tools, signal }); }
      catch (e2) {
        if (!said) throw e2;
        emit({ type: 'note', text: `${engine === 'tinfoil' ? 'Tinfoil' : 'ChatGPT'} stopped partway (${String(e2.message || e2).slice(0, 160)}). What it found is above.` });
        return { ok: true, said };
      }
    }
    const failure = !r.calls.length && providerFailure(r.text);
    if (failure && !said && !acted) return { ok: false, said: false, error: r.text, ...failure };
    if (r.text) { said = true; emit({ type: 'text', role: 'agent', engine, text: r.text }); }
    if (!r.calls.length) return { ok: true, said };
    if (engine === 'chatgpt') msgs.push(...r.replay); else msgs.push(r.replay);
    for (const c of r.calls) {
      acted = true;
      emit({ type: 'tool', engine, text: `${toolLabel(c.name, c.args)}` });
      const out = await callTool(c.name, c.args, { engine, authorize, signal });
      if (engine === 'chatgpt') msgs.push({ type: 'function_call_output', call_id: c.id, output: out });
      else msgs.push({ role: 'tool', tool_call_id: c.id, content: out });
    }
  }
  emit({ type: 'note', text: `Stopped after ${MAX_STEPS} steps.` });
  return { ok: said, said };
}

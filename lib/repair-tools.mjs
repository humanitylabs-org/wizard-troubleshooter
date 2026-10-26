// Provider-independent repair scope. The owner/admin pins exact files and argv in a
// policy file; model input can neither expand that scope nor approve its own writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG, run } from './checks.mjs';

const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const LIMIT = 4096;
function policy() {
  if (!process.env.REPAIR_POLICY_FILE) return { files: [], commands: {} };
  const p = JSON.parse(fs.readFileSync(process.env.REPAIR_POLICY_FILE, 'utf8'));
  if (!Array.isArray(p.files) || !p.commands || typeof p.commands !== 'object') throw new Error('Invalid repair policy');
  return p;
}
function grant(file) {
  return policy().files.map(f => typeof f === 'string' ? { path: f, writable: true } : f).find(f => f.path === file);
}
function validateWrite(file, content) {
  const g = grant(file);
  if (!g || g.writable !== true) throw new Error('File is read-only in the repair policy');
  if (g.format === 'restart-delay' && !/^\[Service\]\nRestartSec=(?:[2-9]|[1-5][0-9]|60)\n$/.test(content)) throw new Error('Only [Service] RestartSec=2..60 is allowed');
  if (g.format && g.format !== 'restart-delay') throw new Error('Unknown write format');
}
function mutationFence() {
  if (process.env.REPAIR_STANDBY_LOCK && fs.existsSync(process.env.REPAIR_STANDBY_LOCK)) throw new Error('Standby role fence: mutations disabled');
}
function checkedFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file || !grant(file)) throw new Error('File is outside the repair allowlist');
  if (file === process.env.REPAIR_POLICY_FILE || /(?:^|\/)(?:\.claude|\.ssh|agents|app-data)(?:\/|$)|(?:^|\/)\.hermes\/(?!cache\/scratch\/)|(?:auth|credential|secret|token|password|private[_-]?key)|\.(?:pem|key|db|sqlite)(?:$|-)/i.test(file)) throw new Error('Protected file');
  let part = path.parse(file).root;
  for (const name of file.split(path.sep).filter(Boolean)) {
    part = path.join(part, name);
    if (fs.lstatSync(part).isSymbolicLink()) throw new Error('Symlink paths are not allowed');
  }
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1 || st.size > LIMIT) throw new Error('Only small, unlinked regular files are allowed');
  return st;
}
function command(id) {
  const p = policy(), c = Object.hasOwn(p.commands, id) && p.commands[id];
  if (!c || !path.isAbsolute(c.executable) || !Array.isArray(c.args) || c.args.some(a => typeof a !== 'string') || !path.isAbsolute(c.cwd || '')) throw new Error('Command is outside the repair allowlist');
  // Policy is an administrative grant, never supplied by the model. No shell or model-supplied argv.
  return c;
}
export function repairDefs() {
  return [
    { name: 'repair_scope', description: 'List the exact owner-configured file and command allowlist. Same scope and approvals for every provider. No arbitrary shell access.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'read_file', description: 'Read a small non-secret regular file on the exact repair allowlist. Returns text and sha256 for compare-and-swap edits.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
    { name: 'write_file', description: 'Propose replacing an allowlisted file. Requires its current sha256 and owner approval in the page. Rechecks scope/hash, backs up, writes, and verifies. Never approve your own request.', parameters: { type: 'object', properties: { path: { type: 'string' }, expected_sha256: { type: 'string' }, content: { type: 'string', maxLength: LIMIT } }, required: ['path', 'expected_sha256', 'content'], additionalProperties: false } },
    { name: 'run_command', description: 'Execute a command id from repair_scope, using its fixed server-configured executable/argv/cwd, only after owner approval in the page. No shell syntax or extra args.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  ];
}
export async function repairTool(name, args, ctx) {
  try {
    if (name === 'repair_scope') {
      const p = policy();
      return JSON.stringify({ files: p.files, commands: p.commands, approval: 'Every file write and command execution needs an explicit owner click; scope changes require host administration.' });
    }
    if (name === 'read_file' || name === 'write_file') {
      const st = checkedFile(args.path), before = fs.readFileSync(args.path);
      if (name === 'read_file') return JSON.stringify({ path: args.path, sha256: hash(before), content: before.toString('utf8') });
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > LIMIT || args.expected_sha256 !== hash(before)) throw new Error('Stale hash or invalid content; read the file again');
      mutationFence(); validateWrite(args.path, args.content);
      if (!ctx.authorize || !await ctx.authorize({ tool: name, args, before: before.toString('utf8') })) throw new Error('Owner approval denied, expired, or unavailable');
      mutationFence(); validateWrite(args.path, args.content);
      checkedFile(args.path);
      if (hash(fs.readFileSync(args.path)) !== args.expected_sha256) throw new Error('File changed while awaiting approval');
      const backups = path.join(CONFIG.stateDir, 'repair-backups'); fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
      const id = crypto.randomBytes(12).toString('hex'), backup = path.join(backups, id);
      fs.writeFileSync(backup, before, { mode: 0o600, flag: 'wx' });
      const tmp = path.join(path.dirname(args.path), `.repair-${id}`);
      try {
        fs.writeFileSync(tmp, args.content, { mode: st.mode & 0o777, flag: 'wx' });
        checkedFile(args.path);
        mutationFence(); validateWrite(args.path, args.content);
        if (hash(fs.readFileSync(args.path)) !== args.expected_sha256) throw new Error('File changed before commit');
        fs.renameSync(tmp, args.path);
      } finally { try { fs.unlinkSync(tmp); } catch {} }
      if (fs.readFileSync(args.path, 'utf8') !== args.content) throw new Error('Write verification failed');
      return JSON.stringify({ ok: true, path: args.path, sha256: hash(args.content), backup });
    }
    if (name === 'run_command') {
      const c = command(args.id), frozen = JSON.stringify(c);
      if (!ctx.authorize || !await ctx.authorize({ tool: name, args: { id: args.id, ...c } })) throw new Error('Owner approval denied, expired, or unavailable');
      if (JSON.stringify(command(args.id)) !== frozen) throw new Error('Command policy changed while awaiting approval');
      mutationFence();
      const r = await run(c.executable, c.args, { cwd: c.cwd, timeout: Math.min(30000, Math.max(1000, c.timeout || 15000)), env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: c.cwd, LANG: 'C.UTF-8' } });
      return JSON.stringify({ ok: r.ok, out: r.out, err: r.err });
    }
  } catch (e) { return `Refused: ${e.message}`; }
}

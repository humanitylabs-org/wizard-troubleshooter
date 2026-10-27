// Hermetic browser runner. The only provider here is a fake binary; no host sign-ins or services are used.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '../..');
const state = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'troubleshooter-ui-'));
const out = path.resolve(process.argv[2] || path.join(root, 'qa'));
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(path.join(state, 'claude'));
fs.writeFileSync(path.join(state, 'claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture', refreshToken: 'fixture' } }));
const port = 27000 + Math.floor(Math.random() * 10000);
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: state, TROUBLESHOOT_STATE: state, PORT: String(port), TROUBLESHOOT_DEV_NO_AUTH: '1', TS_SOCKET: path.join(state, 'no.sock'), AGENT_PORT: '1', HERMES_PORT: '2', SHELL_PORT: '3', GATEWAY_PORT: '4', AUTH_PORT: '', TAILSCALE_UNIT: '', GATEWAY_UNIT: '', SHELL_CONTAINER: '', AGENT_UNIT: '', HERMES_UNIT: '', WAS_RELEASE_ROOT: path.join(state, 'no-release'), CLAUDE_CONFIG_DIR: path.join(state, 'claude'), CLAUDE_BIN: path.join(root, 'tests/ui/fake-claude.sh'), CLAUDE_AGENT_AUTH_FILE: path.join(state, 'no-auth'), CHATGPT_AUTH_FILE: path.join(state, 'no-auth'), CODEX_BIN: '/bin/false', CODEX_HOME: path.join(state, 'no-codex'), TINFOIL_URL: 'http://127.0.0.1:9', TINFOIL_TOKEN_FILE: path.join(state, 'no-token'), DOCKER_BIN: '/bin/false' };
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('server startup timeout')), 5000); server.stdout.once('data', () => { clearTimeout(t); resolve(); }); server.on('exit', () => { clearTimeout(t); reject(new Error('server stopped')); }); });
  const qa = spawn(process.execPath, ['tests/ui/chat-qa.cjs', `http://127.0.0.1:${port}`, out], { cwd: root, env: process.env, stdio: 'inherit' });
  process.exitCode = await new Promise(r => qa.on('exit', r));
} finally { server.kill(); fs.rmSync(state, { recursive: true, force: true }); }

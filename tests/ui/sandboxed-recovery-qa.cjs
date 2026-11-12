// Real-browser check for the sign-in recovery card under the browser owner boundary (wizard-os#133). The Wizard shell
// opens the repair page sandboxed at /troubleshoot/?provider=claude&run_id=<waiting message>; once the Agent Service
// has re-sent that message, the card must say so. The stand-in Agent Service behaves like the real one with the
// boundary on: it refuses every `Origin: null` call and wants the shell token for provider-recovery.
// Usage: PLAYWRIGHT=/path/to/node_modules/playwright node tests/ui/sandboxed-recovery-qa.cjs   (QA_OUT=dir keeps shots)
// Synthetic: throwaway state dir, owner gate off (TROUBLESHOOT_DEV_NO_AUTH), no provider sign-ins.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const APP = path.resolve(__dirname, '..', '..');
const SANDBOX = 'allow-scripts allow-forms allow-downloads'; // wizard-ux core/browser-boundary.js frameAttributes
const RUN = 'wizardq_' + 'c0ffee'.repeat(5) + 'ab';
const TOKEN = 'cd'.repeat(32);
const HOST = `<!doctype html><title>shell</title><body style="margin:0">
<iframe id="repair" sandbox="${SANDBOX}" src="/troubleshoot/?provider=claude&run_id=${RUN}" style="width:390px;height:700px;border:0"></iframe>`;

(async () => {
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-rec-qa-'));
  const tokFile = path.join(state, 'shell-token'); fs.writeFileSync(tokFile, TOKEN + '\n');
  let resent = false;
  const asCalls = [];
  const as = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    asCalls.push({ path: u.pathname, origin: req.headers.origin, token: req.headers['x-wizard-shell-token'] === TOKEN });
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (String(req.headers.origin || '').toLowerCase() === 'null') return json(403, { error: 'opaque_origin' });
    if (req.headers['x-wizard-shell-token'] !== TOKEN) return json(401, { error: 'shell_token_required' });
    if (u.pathname === '/wizard/v1/provider-recovery' && u.searchParams.get('run_id') === RUN) return json(200, { status: resent ? 'completed' : 'queued', resent, sent: resent });
    return json(404, { error: 'not_found' });
  }).listen(0, '127.0.0.1');
  await new Promise(r => as.once('listening', r));
  const tsPort = 30000 + Math.floor(Math.random() * 9000), hostPort = tsPort + 1;
  const env = { ...process.env, HOME: state, TROUBLESHOOT_STATE: state, TROUBLESHOOT_DEV_NO_AUTH: '1', PORT: String(tsPort),
    AGENT_PORT: String(as.address().port), WIZARD_SHELL_TOKEN_FILE: tokFile,
    SHELL_WEB_DIR: path.join(state, 'none'), CLAUDE_BIN: '/bin/false', CLAUDE_CONFIG_DIR: path.join(state, 'none'),
    CHATGPT_AUTH_FILE: path.join(state, 'none.json'), TINFOIL_URL: 'http://127.0.0.1:9', TINFOIL_TOKEN_FILE: path.join(state, 'none.json'),
    TS_SOCKET: path.join(state, 'none.sock'), WAS_RELEASE_ROOT: path.join(state, 'none'), DOCKER_BIN: '/bin/false', TAILSCALE_UNIT: '', GATEWAY_UNIT: '', AUTH_PORT: '' };
  const ts = spawn(process.execPath, [path.join(APP, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, no) => { let o = ''; ts.stdout.on('data', d => { o += d; if (o.includes('/troubleshoot/')) ok(); }); setTimeout(() => no(new Error('no start')), 8000); });
  // The box's gateway: the shell page, /troubleshoot/ and the Agent Service's /wizard/ on one origin.
  const host = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HOST); }
    const port = req.url.startsWith('/wizard/') ? as.address().port : tsPort;
    const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  }).listen(hostPort, '127.0.0.1');
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const results = [];
  const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`); };
  const out = process.env.QA_OUT || state;
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    await page.goto(`http://127.0.0.1:${hostPort}/`);
    const frame = page.frames().find(f => f.url().includes('/troubleshoot/'));
    await frame.waitForLoadState('load');
    check('repair page origin is opaque', await frame.evaluate(() => self.origin) === 'null');
    await frame.waitForFunction(() => /sign-in has expired/.test(document.querySelector('#reconnect')?.innerText || ''), null, { timeout: 8000 });
    check('the card asks for the sign-in while the message waits', true);
    await page.waitForTimeout(1500);
    check('the card does not claim the message was sent yet', !/Your message was sent/.test(await frame.evaluate(() => document.querySelector('#reconnect').innerText)));
    resent = true; // the owner signed in; the Agent Service re-sent the waiting message
    let shown = false;
    try { await frame.waitForFunction(() => /is signed in again\. Your message was sent/.test(document.querySelector('#reconnect')?.innerText || ''), null, { timeout: 6000 }); shown = true; } catch {}
    await page.screenshot({ path: path.join(out, 'sandboxed-recovery-card.png') });
    check('the card says the message was sent', shown);
    check('Back to chat is offered', await frame.evaluate(() => !!document.querySelector('#reconnect [data-back-chat]')));
    const rec = asCalls.filter(c => c.path === '/wizard/v1/provider-recovery');
    check('the Agent Service was asked box-local with the shell token', rec.some(c => c.token && !c.origin), JSON.stringify(rec.slice(-1)));
    check('the Agent Service never answered an opaque page', !asCalls.some(c => String(c.origin).toLowerCase() === 'null' && c.token));
  } finally {
    await browser.close(); host.close(); as.close(); ts.kill();
    if (!process.env.QA_OUT) fs.rmSync(state, { recursive: true, force: true });
  }
  const failed = results.filter(x => !x).length;
  console.log(failed ? `${failed} FAILED` : 'all pass');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

// Real-browser check for the browser owner boundary (wizard-os#133): the repair page loaded the way the Wizard shell
// loads it with WIZARD_BROWSER_BOUNDARY on (sandboxed, no same-origin) still reads its status and can start a repair
// chat, while another sandboxed page on the same box gets refused.
// Usage: PLAYWRIGHT=/path/to/node_modules/playwright node tests/ui/sandboxed-frame-qa.cjs
// Synthetic: throwaway state dir, owner gate off (TROUBLESHOOT_DEV_NO_AUTH), no provider sign-ins.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const APP = path.resolve(__dirname, '..', '..');
const SANDBOX = 'allow-scripts allow-forms allow-downloads'; // wizard-ux core/browser-boundary.js frameAttributes
const HOST = `<!doctype html><title>shell</title>
<iframe id="repair" sandbox="${SANDBOX}" src="/troubleshoot/" style="width:390px;height:700px"></iframe>
<iframe id="hostile" sandbox="${SANDBOX}" src="/hostile.html"></iframe>`;
const HOSTILE = `<!doctype html><script>
(async () => {
  const out = {};
  const H = { 'Content-Type': 'application/json', 'X-Wizard-Troubleshoot': '1' };
  try { const r = await fetch('/troubleshoot/api/status'); out.status = r.status; } catch (e) { out.status = 'blocked'; }
  try { const r = await fetch('/troubleshoot/api/repair', { method: 'POST', headers: H, body: JSON.stringify({ message: 'x' }) }); out.repair = r.status; } catch (e) { out.repair = 'blocked'; }
  try { const r = await fetch('/troubleshoot/', { cache: 'no-store' }); out.page = (await r.text()).length; } catch (e) { out.page = 'blocked'; }
  window.hostileResult = out;
})();
</script>`;

(async () => {
  const state = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ts-sbx-qa-'));
  const tsPort = 30000 + Math.floor(Math.random() * 9000), hostPort = tsPort + 1;
  const env = { ...process.env, HOME: state, TROUBLESHOOT_STATE: state, TROUBLESHOOT_DEV_NO_AUTH: '1', PORT: String(tsPort),
    SHELL_WEB_DIR: path.join(state, 'none'), CLAUDE_BIN: '/bin/false', CLAUDE_CONFIG_DIR: path.join(state, 'none'),
    CHATGPT_AUTH_FILE: path.join(state, 'none.json'), TINFOIL_URL: 'http://127.0.0.1:9', TINFOIL_TOKEN_FILE: path.join(state, 'none.json'),
    TS_SOCKET: path.join(state, 'none.sock'), WAS_RELEASE_ROOT: path.join(state, 'none'), DOCKER_BIN: '/bin/false', TAILSCALE_UNIT: '', GATEWAY_UNIT: '', AUTH_PORT: '' };
  const ts = spawn(process.execPath, [path.join(APP, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, no) => { let o = ''; ts.stdout.on('data', d => { o += d; if (o.includes('/troubleshoot/')) ok(); }); setTimeout(() => no(new Error('no start')), 8000); });
  // The box's gateway: shell pages and /troubleshoot/ on one origin.
  const host = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HOST); }
    if (req.url === '/hostile.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HOSTILE); }
    const up = http.request({ host: '127.0.0.1', port: tsPort, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  }).listen(hostPort, '127.0.0.1');
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const results = [];
  const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`); };
  try {
    const page = await browser.newPage();
    const calls = [];
    page.on('response', r => { if (r.url().includes('/troubleshoot/api/')) calls.push({ url: r.url().replace(/^.*\/troubleshoot/, ''), method: r.request().method(), status: r.status(), key: !!r.request().headers()['x-wizard-troubleshoot-page'] }); });
    await page.goto(`http://127.0.0.1:${hostPort}/`);
    const frame = page.frames().find(f => f.url().includes('/troubleshoot/'));
    await frame.waitForLoadState('load');
    check('repair page origin is opaque', await frame.evaluate(() => self.origin) === 'null');
    check('page key is not left in the page', await frame.evaluate(() => !document.querySelector('meta[name="wizard-troubleshoot-page"]')));
    await page.waitForTimeout(2500);
    const status = calls.find(c => c.url.startsWith('/api/status'));
    check('status read from the sandboxed page', status && status.status === 200 && status.key, JSON.stringify(status));
    check('status painted', await frame.evaluate(() => document.body.innerText.length > 50));
    await frame.fill('#input', 'Wizard is slow');
    await frame.click('#send');
    await page.waitForTimeout(1500);
    const post = calls.find(c => c.method === 'POST' && c.url === '/api/repair');
    check('repair chat started from the sandboxed page', post && post.status === 202 && post.key, JSON.stringify(post));
    const hostile = page.frames().find(f => f.url().includes('/hostile.html'));
    await hostile.waitForFunction(() => window.hostileResult, null, { timeout: 8000 });
    const h = await hostile.evaluate(() => window.hostileResult);
    check('another sandboxed page cannot read status', h.status === 403 || h.status === 'blocked', JSON.stringify(h));
    check('another sandboxed page cannot start a repair', h.repair === 403 || h.repair === 'blocked');
    check('another sandboxed page cannot read the repair page (and its key)', h.page === 'blocked');
    await page.screenshot({ path: path.join(process.env.QA_OUT || state, 'sandboxed-repair-page.png') });
  } finally {
    await browser.close(); host.close(); ts.kill();
    if (!process.env.QA_OUT) fs.rmSync(state, { recursive: true, force: true });
  }
  const failed = results.filter(x => !x).length;
  console.log(failed ? `${failed} FAILED` : 'all pass');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

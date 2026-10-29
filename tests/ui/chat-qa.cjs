// Usage: start server.mjs with TROUBLESHOOT_DEV_NO_AUTH=1 CLAUDE_BIN=tests/ui/fake-claude.sh (and a Claude login dir), then
// PLAYWRIGHT=<path to playwright module> node tests/ui/chat-qa.cjs http://127.0.0.1:<port> [outdir]
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const B = process.argv[2], OUT = process.argv[3] || '.';
(async () => {
  const br = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const r = [];
  const ok = (n, c) => r.push(`${c ? 'PASS' : 'FAIL'} ${n}`);
  for (const [name, vp] of [['phone', { width: 390, height: 844 }], ['narrow', { width: 320, height: 640 }]]) {
    const ctx = await br.newContext({ viewport: vp, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    await p.goto(B + '/troubleshoot/'); await p.waitForSelector('.ts-seg', { timeout: 20000 }); await p.waitForTimeout(800);
    await p.screenshot({ path: `${OUT}/${name}-welcome.png` });
    const segs = await p.locator('.ts-seg').count();
    ok(`${name}: picker shows every provider`, segs === 3);
    const pk = await p.locator('#picker').boundingBox(), ta = await p.locator('textarea').boundingBox();
    ok(`${name}: picker sits directly above the composer`, pk.y + pk.height <= ta.y && ta.y - (pk.y + pk.height) < 16);
    ok(`${name}: composer near the bottom`, ta.y + ta.height > vp.height - 70);
    ok(`${name}: nothing overflows horizontally`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    ok(`${name}: segments fit`, await p.evaluate(() => [...document.querySelectorAll('.ts-seg')].every(s => s.scrollWidth <= s.clientWidth + 1)));
    await ctx.close();
  }
  const p = await br.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await p.goto(B + '/troubleshoot/'); await p.waitForSelector('.ts-seg'); await p.waitForTimeout(800);
  ok('default is Claude', await p.locator('.ts-seg[aria-checked="true"]').getAttribute('data-engine') === 'claude');
  ok('Claude shows its model', /Opus 5\.5/.test(await p.locator('.ts-seg[data-engine="claude"]').textContent()));
  const off = p.locator('.ts-seg.ts-off');
  if (await off.count()) {
    const e = await off.first().getAttribute('data-engine');
    await off.first().tap({ force: true }); await p.waitForTimeout(300);
    ok('disabled provider cannot be picked', await p.locator('.ts-seg[aria-checked="true"]').getAttribute('data-engine') === 'claude' && e !== 'claude');
  }
  await p.locator('.ts-chip.ts-main').tap();
  await p.waitForSelector('.ts-msg.ts-agent', { timeout: 15000 }); await p.waitForSelector('#send:not(.ts-stop)', { timeout: 8000 });
  ok('answer labelled with provider and model', /Claude · Opus 5\.5/.test(await p.locator('.ts-msg.ts-agent .ts-who').first().textContent()));
  ok('single owner message', (await p.locator('.ts-msg.ts-owner').count()) === 1);
  ok('the one-tap buttons give way to the conversation', !(await p.locator('#welcome').isVisible()));
  ok('after a reply, one-tap follow-ups are offered', (await p.locator('.ts-after .ts-chip').count()) === 3);
  await p.screenshot({ path: `${OUT}/phone-reply.png` });
  await p.locator('#pill').tap(); await p.waitForTimeout(800);
  ok('details sheet opens', await p.locator('#sheet[open]').isVisible());
  ok('sheet has no engine dropdown', (await p.locator('#sheet select').count()) === 0);
  await p.screenshot({ path: `${OUT}/phone-sheet.png` });
  await p.goBack(); await p.waitForTimeout(400);
  ok('back closes sheet', !(await p.locator('#sheet[open]').count()));
  await p.reload(); await p.waitForTimeout(1500);
  ok('reload restores conversation', (await p.locator('.ts-msg.ts-agent').count()) === 1);
  // Past repair chats: listed in the details sheet with their first line; tapping one opens it.
  await p.locator('[data-new]').tap(); await p.waitForTimeout(500);
  ok('Something else brings back the one-tap buttons', await p.locator('#welcome').isVisible() && (await p.locator('.ts-chips .ts-chip').count()) === 4 && !(await p.locator('.ts-msg').count()));
  await p.waitForSelector('#recent:not([hidden]) .ts-past');
  ok('recent chats show under the one-tap buttons', /My Wizard is down/.test(await p.locator('#recentList .ts-past').first().textContent()));
  ok('status line is one plain sentence', /^(Everything is working|Something's wrong: .+|Slow: .+|\d+ things need fixing)$/.test((await p.locator('#pillText').textContent()).trim()));
  await p.screenshot({ path: `${OUT}/phone-recent.png` });
  await p.locator('#recentList .ts-past').first().tap(); await p.waitForTimeout(1200);
  ok('tapping a recent chat reopens it', (await p.locator('.ts-msg.ts-agent').count()) === 1 && /#r=[a-f0-9]{16}/.test(p.url()));
  await p.locator('[data-new]').tap(); await p.waitForTimeout(500);
  await p.locator('#pill').tap(); await p.waitForSelector('#sheet[open] .ts-past');
  ok('details list the past chat with its first line', /My Wizard is down/.test(await p.locator('#past .ts-past').first().textContent()));
  await p.locator('#past .ts-past').first().tap(); await p.waitForTimeout(1200);
  ok('past chat opens with the sheet closed', !(await p.locator('#sheet[open]').count()) && (await p.locator('.ts-msg.ts-agent').count()) === 1 && /#r=[a-f0-9]{16}/.test(p.url()));
  const d = await br.newPage({ viewport: { width: 1280, height: 860 } });
  await d.goto(B + '/troubleshoot/'); await d.waitForSelector('.ts-seg'); await d.waitForTimeout(800);
  await d.screenshot({ path: `${OUT}/desktop.png` });
  await d.locator('#recheck').click(); await d.waitForFunction(() => document.getElementById('recheck').textContent === 'Check again', null, { timeout: 15000 });
  ok('desktop: Check again re-checks and settles', /working|wrong|need fixing|Slow|Can't check/.test(await d.locator('#pillText').textContent()));
  ok('desktop: one-tap buttons on the welcome screen', (await d.locator('.ts-chips .ts-chip').count()) === 4 && await d.locator('.ts-chip.ts-main').isVisible());
  // A status-only sign-in failure must stay actionable even with both normal-agent services down.
  for (const [engine, label] of [['claude', 'Claude'], ['chatgpt', 'ChatGPT']]) for (const skin of ['dark', 'light']) {
    const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await ctx.addInitScript(skin => {
      if (skin !== 'light') return;
      document.addEventListener('DOMContentLoaded', () => {
        const vars = { '--wz-bg': '#fff', '--wz-surface': '#f3f4f6', '--wz-surface-2': '#e5e7eb', '--wz-text': '#111827', '--wz-text-muted': '#4b5563', '--wz-border': '#d1d5db' };
        for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
      });
    }, skin);
    await ctx.route('**/troubleshoot/api/status**', route => route.fulfill({ json: {
      overall: 'down', actions: {}, checks: [
        { id: 'agent-service', label: 'Agent Service', ok: false, detail: 'Not running.' },
        { id: 'hermes', label: 'Your agent (Hermes)', ok: false, detail: 'Not running.' },
        { id: 'agent-reply', label: 'Your agent can reply', ok: false, state: 'expired', provider: label, detail: `${label} sign-in expired.` }
      ], reconnect: { engine, app: `${label} app`, appId: `wizard-${engine}`, installed: true, state: 'expired', open: `/wizard-${engine}/` }
    } }));
    await ctx.route(`**/wizard-${engine}/`, route => route.fulfill({ contentType: 'text/html', body: `<h1>${label} Connect</h1>` }));
    const p = await ctx.newPage();
    await p.goto(B + '/troubleshoot/'); await p.waitForSelector('#reconnect:not([hidden])');
    ok(`${label}/${skin}: one focused sign-in path, nothing else on screen`, !(await p.locator('#scroll').isVisible()) && /sign-in has expired/.test(await p.locator('#reconnect h2').textContent()));
    const button = p.getByRole('link', { name: `Sign in to ${label}`, exact: true });
    ok(`${label}/${skin}: exactly one reconnect action`, await button.count() === 1);
    const rect = await button.boundingBox();
    ok(`${label}/${skin}: phone tap target is at least 44px tall`, rect.height >= 44);
    ok(`${label}/${skin}: no horizontal overflow with the normal agent down`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.screenshot({ path: `${OUT}/phone-expired-${engine}-${skin}.png` });
    await button.tap(); await p.waitForURL(`**/wizard-${engine}/`);
    ok(`${label}/${skin}: one tap opens the existing connection app`, await p.locator('h1').textContent() === `${label} Connect`);
    await p.goBack(); await p.waitForSelector('#reconnect:not([hidden])');
    ok(`${label}/${skin}: Back returns to the repair chat`, p.url().includes('/troubleshoot/'));
    await ctx.close();
  }
  console.log(r.join('\n')); await br.close();
  if (r.some(x => x.startsWith('FAIL'))) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });

// Usage: start server.mjs with TROUBLESHOOT_DEV_NO_AUTH=1 CLAUDE_BIN=tests/ui/fake-claude.sh, then
// PLAYWRIGHT=<path to playwright module> node tests/ui/chat-qa.cjs http://127.0.0.1:<port>
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const B = process.argv[2];
(async () => {
  const br = await chromium.launch();
  const p = await br.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const r = [];
  const ok = (n, c) => r.push(`${c ? 'PASS' : 'FAIL'} ${n}`);
  await p.goto(B + '/troubleshoot/'); await p.waitForTimeout(1200);
  await p.screenshot({ path: 'welcome.png' });
  ok('main chip visible above fold', await p.locator('.chip.main').isVisible() && (await p.locator('.chip.main').boundingBox()).y < 600);
  ok('composer at bottom', (await p.locator('textarea').boundingBox()).y > 760);
  ok('pill shows status', /working|problem/i.test(await p.locator('#pillText').textContent()));
  await p.locator('.chip.main').tap();
  await p.waitForTimeout(1800);
  ok('owner bubble shown', (await p.locator('.msg.owner').count()) === 1);
  ok('working indicator', await p.locator('.working').isVisible());
  await p.screenshot({ path: 'working.png' });
  await p.waitForSelector('.msg.agent', { timeout: 15000 });
  await p.waitForSelector('.after', { timeout: 8000 });
  ok('agent reply with markup', (await p.locator('.msg.agent b').count()) === 1);
  ok('single owner bubble (no duplicate)', (await p.locator('.msg.owner').count()) === 1);
  ok('follow-up chips', (await p.locator('.after .chip').count()) === 3);
  await p.screenshot({ path: 'reply.png' });
  await p.locator('#pill').tap(); await p.waitForTimeout(800);
  ok('details sheet opens', await p.locator('#sheet.open').isVisible());
  await p.screenshot({ path: 'sheet.png' });
  await p.goBack(); await p.waitForTimeout(400);
  ok('back closes sheet, stays on page', !(await p.locator('#sheet.open').count()) && p.url().includes('/troubleshoot/'));
  await p.reload(); await p.waitForTimeout(1500);
  ok('reload restores conversation', (await p.locator('.msg.agent').count()) === 1 && (await p.locator('.msg.owner').count()) === 1);
  await p.locator('[data-new]').tap(); await p.waitForTimeout(300);
  ok('something else returns to chips', await p.locator('.chip.main').isVisible());
  console.log(r.join('\n')); await br.close();
})().catch(e => { console.error(e); process.exit(1); });

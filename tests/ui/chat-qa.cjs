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
    await p.goto(B + '/troubleshoot/'); await p.waitForSelector('.seg', { timeout: 20000 }); await p.waitForTimeout(800);
    await p.screenshot({ path: `${OUT}/${name}-welcome.png` });
    const segs = await p.locator('.seg').count();
    ok(`${name}: picker shows every provider`, segs === 3);
    const pk = await p.locator('#picker').boundingBox(), ta = await p.locator('textarea').boundingBox();
    ok(`${name}: picker sits directly above the composer`, pk.y + pk.height <= ta.y && ta.y - (pk.y + pk.height) < 16);
    ok(`${name}: composer near the bottom`, ta.y + ta.height > vp.height - 70);
    ok(`${name}: nothing overflows horizontally`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    ok(`${name}: segments fit`, await p.evaluate(() => [...document.querySelectorAll('.seg')].every(s => s.scrollWidth <= s.clientWidth + 1)));
    await ctx.close();
  }
  const p = await br.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await p.goto(B + '/troubleshoot/'); await p.waitForSelector('.seg'); await p.waitForTimeout(800);
  ok('default is Claude', await p.locator('.seg[aria-checked="true"]').getAttribute('data-engine') === 'claude');
  ok('Claude shows its model', /Opus 5\.5/.test(await p.locator('.seg[data-engine="claude"]').textContent()));
  const off = p.locator('.seg.off');
  if (await off.count()) {
    const e = await off.first().getAttribute('data-engine');
    await off.first().tap({ force: true }); await p.waitForTimeout(300);
    ok('disabled provider cannot be picked', await p.locator('.seg[aria-checked="true"]').getAttribute('data-engine') === 'claude' && e !== 'claude');
  }
  await p.locator('.chip.main').tap();
  await p.waitForSelector('.msg.agent', { timeout: 15000 }); await p.waitForSelector('.after', { timeout: 8000 });
  ok('answer labelled with provider and model', /Claude · Opus 5\.5/.test(await p.locator('.msg.agent .who').first().textContent()));
  ok('single owner bubble', (await p.locator('.msg.owner').count()) === 1);
  await p.screenshot({ path: `${OUT}/phone-reply.png` });
  await p.locator('#pill').tap(); await p.waitForTimeout(800);
  ok('details sheet opens', await p.locator('#sheet[open]').isVisible());
  ok('sheet has no engine dropdown', (await p.locator('#sheet select').count()) === 0);
  await p.screenshot({ path: `${OUT}/phone-sheet.png` });
  await p.goBack(); await p.waitForTimeout(400);
  ok('back closes sheet', !(await p.locator('#sheet[open]').count()));
  await p.reload(); await p.waitForTimeout(1500);
  ok('reload restores conversation', (await p.locator('.msg.agent').count()) === 1);
  const d = await br.newPage({ viewport: { width: 1280, height: 860 } });
  await d.goto(B + '/troubleshoot/'); await d.waitForSelector('.seg'); await d.waitForTimeout(800);
  await d.screenshot({ path: `${OUT}/desktop.png` });
  console.log(r.join('\n')); await br.close();
  if (r.some(x => x.startsWith('FAIL'))) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });

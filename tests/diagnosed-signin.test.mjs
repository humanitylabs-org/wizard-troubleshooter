import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const page=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
test('the welcome screen keeps James\'s original one-tap repair path',()=>{
 assert.match(page, /<h1>Fix Wizard<\/h1>/);
 assert.match(page, /What's wrong\?/);
 assert.match(page, /Tell me and I'll fix it, even when Wizard's normal chat is down\./);
 const chips=page.slice(page.indexOf('<div class="ts-chips"'),page.indexOf('<div class="ts-log"'));
 assert.deepEqual([...chips.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m=>m[1]), ['My Wizard is down', "Messages won't send", "My agent isn't replying", 'Wizard is slow']);
 assert.match(page, /I can already see a problem with/);
 assert.match(page, /\.ts-chips \{ display: flex; flex-direction: column;/);
 assert.doesNotMatch(page, /id="(?:recheck|recent|recentList)"|Fix it:/);
 assert.match(page, /<div id="pastWrap" hidden><h2>Earlier repair chats<\/h2>/);
 assert.match(page, /It works now<\/button>.*Still not working<\/button>.*Something else<\/button>/);
});
test('a diagnosed problem shows one fix path in Fix Wizard',()=>{
 assert.match(page,/Your Wizard can't send messages to/);assert.match(page,/<ol><li>Tap Sign in to/);assert.match(page,/Come back here\. Your waiting message sends on its own/);assert.match(page,/Something else is wrong/);
 for(const selector of ['#scroll','.ts-composer','footer','#picker','#pill'])assert.ok(page.includes('body.ts-diagnosed '+selector));
 assert.doesNotMatch(page,/body\.ts-diagnosed \{ --/,'the sign-in path keeps the selected skin; it never sets its own colours');
 assert.match(page,/appLink\(diagnosed, `Sign in to \$\{name\}`/);assert.match(page,/\['claude', 'chatgpt'\].includes\(a.engine\)/);
});
test('Back to chat asks the shell to go back, never navigates the top-level shell',()=>{
 assert.match(page,/WizardApp\?\.nav\?\.back\?\./);assert.doesNotMatch(page,/top\.location|parent\.location/);assert.match(page,/if \(sheetOpen\(\)\)/);
});
test('sign-in confirmation waits for the saved resend to finish, not merely an account status',()=>{
 assert.match(page,/provider-recovery\?run_id=/);assert.match(page,/if \(r.ok && \(await r.json\(\)\).sent\)/);assert.match(page,/is signed in again\. Your message was sent/);assert.match(page,/data-back-chat>Back to chat/);
});
test('the page may load the shell kit and skin stylesheets (same origin only)',()=>{
 const src=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 assert.match(src,/style-src 'self' 'unsafe-inline'/);assert.match(page,/href="\/wizard-os-home\/kit\/wizard-tokens\.css"/);
});
test('every class the page uses is ts- prefixed, so skin and shell stylesheets cannot restyle it',()=>{
 const css=page.slice(page.indexOf('<style>'),page.indexOf('</style>'));
 const bare=[...css.matchAll(/(?<![\d])\.([a-z][a-z0-9-]*)(?![\w-])/g)].map(m=>m[1]).filter(n=>!n.startsWith('ts-'));
 assert.deepEqual([...new Set(bare)],[]);
 const attrs=[...page.matchAll(/class=\\?"([^"\\$]*)/g)].flatMap(m=>m[1].split(/\s+/)).filter(Boolean).filter(n=>!n.startsWith('ts-'));
 assert.deepEqual([...new Set(attrs)],[]);
});

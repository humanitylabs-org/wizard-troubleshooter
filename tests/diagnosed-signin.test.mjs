import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const page=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
test('a diagnosed problem shows one fix path in Fix Wizard',()=>{
 assert.match(page,/Your Wizard can't send messages to/);assert.match(page,/<ol><li>Tap Sign in to/);assert.match(page,/Come back here\. Your waiting message sends on its own/);assert.match(page,/Something else is wrong/);
 for(const selector of ['#scroll','.composer','footer','#picker','#pill'])assert.ok(page.includes('body.diagnosed '+selector));
 assert.doesNotMatch(page,/body\.diagnosed \{ --/,'the sign-in path keeps the selected skin; it never sets its own colours');
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

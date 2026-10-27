import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const page = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
const start = page.indexOf('  async function refresh(fresh, accounts) {')
const end = page.indexOf('  async function loadIncidents()', start)
for (const [fresh, accounts, expected] of [[false, false, 'status'], [true, false, 'status?fresh=1'], [false, true, 'status?accounts=1'], [true, true, 'status?fresh=1&accounts=1']]) {
  test(`expired sign-in page arrival uses a gateway-safe status URL (${fresh}, ${accounts})`, async () => {
    const seen = []
    const context = vm.createContext({ URLSearchParams, running: false, api: async path => { seen.push(path); return {} }, paintStatus: () => {}, loadEngines: () => {} })
    vm.runInContext(page.slice(start, end), context)
    await context.refresh(fresh, accounts)
    assert.deepEqual(seen, [expected])
  })
}
test('expired sign-in recovery is prominent without opening system details', () => {
  assert.match(page, /id="reconnect"[^>]+role="status"/)
  assert.ok(page.indexOf('id="reconnect"') < page.indexOf('id="scroll"'))
  assert.match(page, /Sign in to \$\{name\} again/)
})

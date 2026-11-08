import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Wizard's phone and desktop shell probe the repair page with HEAD before it opens the page.
// A 404 here made the shell say "The repair page isn't available" while the page was up (8 Nov 2026).
test('repair page and ping answer HEAD like GET so the shell opens the real Troubleshooter', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-head-'))
  const port = 30000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, TROUBLESHOOT_DEV_NO_AUTH: '1', TROUBLESHOOT_STATE: state, HOME: state, PORT: String(port) }, stdio: 'ignore' })
  try {
    const base = `http://127.0.0.1:${port}/troubleshoot/`
    for (let i = 0; i < 50; i++) { try { await fetch(base + 'api/ping'); break } catch { await new Promise(r => setTimeout(r, 100)) } }
    for (const p of ['', 'api/ping']) {
      const get = await fetch(base + p), head = await fetch(base + p, { method: 'HEAD' })
      assert.equal(head.status, get.status, `HEAD /${p} must match GET`)
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')
    }
  } finally { child.kill(); fs.rmSync(state, { recursive: true, force: true }) }
})

// WizardOS is one word, always (James, 8 Nov 2026): no tracked text spells the product name as two words.
// The lowercase identifier wizard-os (repo, paths, slugs, ids) and anything joined to a path, an id or a longer word
// stays as written. Same rule as wizard-agent-service server/product-name.mjs and wizard-ux tests/wizardos-name.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VARIANT = /(?:(?<![\p{L}\p{N}_/.~-])|(?<=\\[ntr]))wizard(?:[ \t\u00a0\u2009\u202f]+|[ \t\u00a0]*[-\u2010\u2011\u2013\u2014][ \t\u00a0]*)os(?![\p{L}\p{N}_/-])/giu
const misspells = (line) => [...line.matchAll(VARIANT)].some((match) => match[0] !== 'wizard-os')

test('the spelling rule keeps identifiers', () => {
  const two = `Wizard${' '}OS`
  for (const bad of [two, two.toLowerCase(), `\\n${two}`, `Wizard${'-'}OS`, `Wizard${' \u2014 '}OS`, `the ${two} app`]) assert.ok(misspells(bad), bad)
  for (const ok of ['WizardOS', 'wizard-os', 'humanitylabs-org/wizard-os', 'wizard-os-home', 'wizard_os', '~/.wizard-os', 'WIZARD_OS_HOME']) assert.ok(!misspells(ok), ok)
})

test('no tracked text spells the product name as two words', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
  const hits = []
  for (const file of files) {
    if (/(^|\/)(node_modules|evidence)\//u.test(file)) continue
    let text
    try { if (statSync(ROOT + file).size > 4 * 1024 * 1024) continue; text = readFileSync(ROOT + file, 'utf8') } catch { continue }
    if (text.includes('\u0000')) continue
    text.split('\n').forEach((line, index) => { if (misspells(line)) hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`) })
  }
  assert.deepEqual(hits, [], 'The product name is WizardOS, one word')
})

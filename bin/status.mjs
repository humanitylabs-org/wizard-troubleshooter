#!/usr/bin/env node
// Plain-language status of every link between the owner's devices and their agent.
import { runChecks, accountChecks, readIncidents } from '../lib/checks.mjs';
const s = await runChecks();
console.log(`Overall: ${s.overall.toUpperCase()} — ${s.summary}`);
for (const c of s.checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.label}: ${c.detail}`);
if (process.argv.includes('--accounts')) for (const a of await accountChecks()) console.log(`${a.ok ? 'OK  ' : 'FAIL'}  ${a.label}: ${a.detail}`);
const inc = readIncidents(8);
if (inc.length) { console.log('\nRecent incidents:'); for (const i of inc) console.log(`  ${i.at}  ${i.kind}  ${i.text || i.detail || i.action || ''}`); }
process.exit(s.overall === 'ok' ? 0 : 1);

#!/usr/bin/env node
// Owner-correction guard (wizard-ux#1565; copied unchanged into wizard-troubleshooter for #53, keep the copies in step). A test that pins something the owner explicitly corrected carries a marker:
//   // owner-correction: humanitylabs-org/wizard-ux#1472 · 2026-11-15 · "It should pop up."
// A PR fails this check when it deletes such a test, removes or edits its marker or quote, drops one of the assertions
// that follow the marker, or marks the test skip/todo, unless it carries the label `owner-approved-change` and its
// body links the owner's approving comment (…/issues/<n>#issuecomment-<id>, written by an approver login).
// Moving or renaming the file with the marker and its assertions intact passes.
// CI (.github/workflows/owner-corrections.yml, pull_request_target: it reads the PR's files as data and never runs them):
//   BASE=<base sha> HEAD=<head sha> PR_BODY=<body> PR_LABELS='["a","b"]' GITHUB_TOKEN=… node tools/owner-corrections.mjs
// Local: node tools/owner-corrections.mjs --base origin/main --head HEAD   (prints problems, exit 1 on any)
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const LABEL = 'owner-approved-change';
export const APPROVERS = ['jdefleur'];
// One line; `//` (JS/Java/Kotlin/Swift) or `#` (Python/shell). Separators are the middle dot from the convention.
export const MARKER = /^\s*(?:\/\/|#)\s*owner-correction:\s*([\w.-]+\/[\w.-]+#\d+)\s*·\s*(\d{4}-\d{2}-\d{2})\s*·\s*(["“].+["”])\s*$/;
const LOOSE = /owner-correction\s*:/;
const ASSERTION = /\bassert\w*\b|\bexpect\s*\(|\bself\.assert\w+\(|\bassertThat\(/;
const SKIP = /\b(?:test|it|describe|suite)\.(?:skip|todo)\s*\(|[{,]\s*(?:skip|todo)\s*:\s*(?!false\b)|\bxit\s*\(|\bxdescribe\s*\(|@(?:unittest\.)?skip|pytest\.mark\.(?:skip|xfail)|@Ignore\b|@Disabled\b|\bt\.skip\s*\(/;
const TEST_FILE = /(^|\/)(tests?|__tests__|androidTest)\/|\.(test|spec)\.[cm]?[jt]s$|(^|\/)test_[^/]+\.py$/;
const COMMENT = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)/g;

const norm = s => s.trim().replace(/\s+/g, ' ');

/** Markers in one file: [{ path, line, ref, date, quote, text, asserts:[normalised lines], skipped }]. Also returns
 *  malformed marker lines (the word is there but the format is not), which fail on their own. */
export function scan(path, source) {
  const lines = String(source).replace(/\r/g, '').split('\n');
  const found = [], malformed = [];
  lines.forEach((l, i) => {
    if (!LOOSE.test(l) || !/^\s*(?:\/\/|#)/.test(l)) return;
    const m = l.match(MARKER);
    if (!m) { malformed.push({ path, line: i + 1, text: l.trim() }); return; }
    // The guarded block: from the marker to the first top-level close (a line starting with `}` at column 0, the end
    // of a top-level test()/for block), or the next marker, or for Python the next top-level def/class.
    const block = [];
    for (let j = i + 1; j < lines.length && j < i + 400; j++) {
      const b = lines[j];
      if (MARKER.test(b)) break;
      // Python: the next top-level def/class/decorator after the marked test's own def ends it.
      if (/^(def |class |@|async def )/.test(b) && block.some(x => /^\s*(async )?def /.test(x))) break;
      block.push(b);
      if (/^[}\]]/.test(b)) break;
    }
    const asserts = block.filter(b => ASSERTION.test(b) && !/^\s*(\/\/|#)/.test(b)).map(norm);
    const skipped = block.some(b => !/^\s*(\/\/|#)/.test(b) && SKIP.test(b));
    found.push({ path, line: i + 1, ref: m[1], date: m[2], quote: m[3], text: norm(l.replace(/^\s*(?:\/\/|#)\s*/, '')), asserts, skipped });
  });
  return { found, malformed };
}

/** Compare markers at base and head. Returns problems (strings); empty = nothing owner-protected was weakened. */
export function compare(baseMarkers, headMarkers) {
  const problems = [];
  const pool = headMarkers.map(m => ({ ...m, used: false }));
  for (const b of baseMarkers) {
    const same = pool.filter(h => !h.used && h.text === b.text);
    if (!same.length) {
      problems.push(`${b.path}:${b.line}: owner-correction test for ${b.ref} (${b.date}, ${b.quote}) was deleted, or its marker or quote was edited.`);
      continue;
    }
    // Prefer the copy that kept everything (same path first, so a duplicate elsewhere can't hide a weakened original).
    const keeps = h => b.asserts.every(a => h.asserts.includes(a)) && (b.skipped || !h.skipped);
    const best = same.find(h => h.path === b.path && keeps(h)) || same.find(keeps) || same.find(h => h.path === b.path) || same[0];
    best.used = true;
    const lost = b.asserts.filter(a => !best.asserts.includes(a));
    if (lost.length) problems.push(`${best.path}:${best.line}: owner-correction test for ${b.ref} lost ${lost.length} assertion(s): ${lost.map(a => JSON.stringify(a.slice(0, 120))).join('; ')}`);
    if (best.skipped && !b.skipped) problems.push(`${best.path}:${best.line}: owner-correction test for ${b.ref} is now marked skip/todo.`);
  }
  return problems;
}

/** Approval: the label plus a linked comment written by an approver. fetchComment(owner, repo, id) -> { login } | null. */
export async function approval({ labels = [], body = '', approvers = APPROVERS, fetchComment }) {
  if (!labels.includes(LABEL)) return { ok: false, why: `no \`${LABEL}\` label` };
  const links = [...String(body).matchAll(COMMENT)];
  if (!links.length) return { ok: false, why: `label \`${LABEL}\` is set, but the PR body links no owner comment (https://github.com/<owner>/<repo>/issues/<n>#issuecomment-<id>)` };
  if (!fetchComment) return { ok: false, why: 'cannot read the linked comment to check who wrote it (no GitHub token)' };
  for (const [url, owner, repo, , id] of links) {
    let c = null;
    try { c = await fetchComment(owner, repo, id); } catch { c = null; }
    if (c && approvers.includes(c.login)) return { ok: true, url, login: c.login };
  }
  return { ok: false, why: `none of the linked comments was written by ${approvers.map(a => '@' + a).join(' or ')}` };
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });

/** All markers in tracked test files at a commit (read from git objects: nothing is checked out or executed). */
export function markersAt(cwd, rev) {
  const files = git(cwd, ['ls-tree', '-r', '--name-only', rev]).split('\n').filter(p => p && TEST_FILE.test(p));
  const out = { found: [], malformed: [] };
  if (!files.length) return out;
  const hits = new Set();
  try { // only files that mention the marker word: one cheap grep over the tree instead of reading every test
    for (const l of git(cwd, ['grep', '-l', '-I', 'owner-correction', rev, '--', ...files]).split('\n')) if (l) hits.add(l.slice(rev.length + 1));
  } catch { /* git grep exits 1 when nothing matches */ }
  for (const p of hits) {
    const { found, malformed } = scan(p, git(cwd, ['show', `${rev}:${p}`]));
    out.found.push(...found); out.malformed.push(...malformed);
  }
  return out;
}

export async function guard({ cwd = process.cwd(), base, head, labels = [], body = '', approvers = APPROVERS, fetchComment }) {
  const b = markersAt(cwd, base), h = markersAt(cwd, head);
  const baseMalformed = new Set(b.malformed.map(m => m.text));
  const problems = compare(b.found, h.found);
  // A new or edited marker line that doesn't follow the format would silently protect nothing: fail it at once.
  const format = h.malformed.filter(m => !baseMalformed.has(m.text))
    .map(m => `${m.path}:${m.line}: owner-correction marker is malformed. Use: // owner-correction: <owner>/<repo>#<n> · YYYY-MM-DD · "<the owner's words>"`);
  const newOnes = h.found.filter(x => !b.found.some(y => y.text === x.text)).map(x => `${x.path}:${x.line} ${x.ref} ${x.date} ${x.quote}`);
  if (!problems.length) return { ok: !format.length, problems: format, approved: null, base: b.found.length, head: h.found.length, newOnes };
  const ok = await approval({ labels, body, approvers, fetchComment });
  return { ok: ok.ok && !format.length, problems: [...problems, ...format], approved: ok, base: b.found.length, head: h.found.length, newOnes };
}

export function githubComment(token) {
  if (!token) return null;
  return async (owner, repo, id) => {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${id}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'wizard-troubleshooter-owner-corrections' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return { login: j?.user?.login || '' };
  };
}

async function main(argv) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const base = arg('--base') || process.env.BASE, head = arg('--head') || process.env.HEAD_SHA || 'HEAD';
  if (!base) { console.error('usage: node tools/owner-corrections.mjs --base <rev> [--head <rev>]'); return 2; }
  let labels = [];
  try { labels = JSON.parse(process.env.PR_LABELS || '[]'); } catch { labels = []; }
  const approvers = (process.env.OWNER_CORRECTION_APPROVERS || '').split(/[\s,]+/).filter(Boolean);
  const r = await guard({ base, head, labels, body: process.env.PR_BODY || '', approvers: approvers.length ? approvers : APPROVERS,
    fetchComment: githubComment(process.env.GITHUB_TOKEN) });
  console.log(`owner-correction tests: ${r.base} on base, ${r.head} on head`);
  for (const n of r.newOnes) console.log(`  new: ${n}`);
  for (const p of r.problems) console.log(`${r.ok ? 'approved' : '::error::'} ${p}`);
  if (r.approved?.ok) console.log(`Approved by @${r.approved.login}: ${r.approved.url}`);
  else if (r.approved && !r.ok) console.log(`::error::Owner-correction tests changed without approval: ${r.approved.why}. Keep the tests, or add the label \`${LABEL}\` and link the owner's approving comment in the PR body.`);
  return r.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main(process.argv.slice(2));

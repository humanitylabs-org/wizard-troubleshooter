// The owner-correction guard (wizard-ux#1565): a test that quotes an owner's correction can't be deleted, edited,
// weakened or skipped without the `owner-approved-change` label and a link to the owner's own approving comment.
// Runs the real tool against throwaway git repos (base commit → PR commit), the way CI runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { guard, scan, LABEL } from '../tools/owner-corrections.mjs';

const MARK = '// owner-correction: humanitylabs-org/wizard-ux#1472 · 2026-11-15 · "It should pop up."';
const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('something else', () => { assert.ok(true); });

${MARK}
for (const kind of ['offline', 'reconnecting']) {
  test(\`the Troubleshooter pops up on its own (\${kind})\`, () => {
    assert.equal(opened(), 1, 'past the grace the Troubleshooter opens by itself');
    assert.equal(card(), undefined, 'the real Troubleshooter, not the checks card');
  });
}

test('unrelated', () => { assert.equal(1, 1); });
`;
const APPROVAL = 'https://github.com/humanitylabs-org/wizard-ux/issues/1472#issuecomment-123';
const comments = { 123: 'jdefleur', 456: 'someone-else' };
const fetchComment = async (o, r, id) => comments[id] ? { login: comments[id] } : null;

function repo(files = { 'tests/offline.test.mjs': TEST }) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'owner-corr-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't');
  const put = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
  for (const [p, s] of Object.entries(files)) put(p, s);
  g('add', '-A'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  return { dir, base, put, read: p => readFileSync(join(dir, p), 'utf8'),
    rm: p => rmSync(join(dir, p)), mv: (a, b) => { mkdirSync(dirname(join(dir, b)), { recursive: true }); renameSync(join(dir, a), join(dir, b)); },
    commit() { g('add', '-A'); g('commit', '-qm', 'pr', '--allow-empty'); return g('rev-parse', 'HEAD'); },
    done() { rmSync(dir, { recursive: true, force: true }); } };
}
const run = (r, head, extra = {}) => guard({ cwd: r.dir, base: r.base, head, fetchComment, ...extra });

test('the marker format parses, and the guarded block is the marked test with its assertions', () => {
  const { found, malformed } = scan('tests/offline.test.mjs', TEST);
  assert.equal(malformed.length, 0);
  assert.equal(found.length, 1);
  assert.equal(found[0].ref, 'humanitylabs-org/wizard-ux#1472');
  assert.equal(found[0].date, '2026-11-15');
  assert.equal(found[0].quote, '"It should pop up."');
  assert.equal(found[0].asserts.length, 2, 'only the marked test, not its neighbours');
  assert.equal(found[0].skipped, false);
});

test('a PR that deletes the #1472 owner-correction test fails the guard', async () => {
  const r = repo();
  try {
    r.rm('tests/offline.test.mjs');
    const res = await run(r, r.commit());
    assert.equal(res.ok, false);
    assert.match(res.problems[0], /#1472.*deleted/);
  } finally { r.done(); }
});

test('the same deletion passes with the label and a link to the owner’s approving comment', async () => {
  const r = repo();
  try {
    r.rm('tests/offline.test.mjs');
    const head = r.commit();
    assert.equal((await run(r, head, { labels: [LABEL], body: `Owner approval: ${APPROVAL}` })).ok, true);
    // The label alone is not enough, a link alone is not enough, and the comment must be the owner's.
    assert.equal((await run(r, head, { labels: [LABEL], body: 'James said yes' })).ok, false);
    assert.equal((await run(r, head, { labels: [], body: APPROVAL })).ok, false);
    const other = await run(r, head, { labels: [LABEL], body: APPROVAL.replace('123', '456') });
    assert.equal(other.ok, false); assert.match(other.approved.why, /@jdefleur/);
    const unknown = await run(r, head, { labels: [LABEL], body: APPROVAL.replace('123', '789') });
    assert.equal(unknown.ok, false, 'a comment that cannot be read approves nothing');
    assert.equal((await run(r, head, { labels: [LABEL], body: APPROVAL, fetchComment: null })).ok, false, 'no token: fail closed');
  } finally { r.done(); }
});

test('a PR that only moves or renames the file passes', async () => {
  const r = repo();
  try {
    r.mv('tests/offline.test.mjs', 'tests/reach/offline-pill-popup.test.mjs');
    const res = await run(r, r.commit());
    assert.equal(res.ok, true, res.problems.join('\n'));
    assert.equal(res.head, 1);
  } finally { r.done(); }
});

test('editing the quote or the marker fails', async () => {
  for (const edit of [s => s.replace('It should pop up.', 'It may pop up.'), s => s.replace('2026-11-15', '2026-11-16'), s => s.replace(MARK, '// It should pop up.')]) {
    const r = repo();
    try {
      r.put('tests/offline.test.mjs', edit(TEST));
      assert.equal((await run(r, r.commit())).ok, false);
    } finally { r.done(); }
  }
});

test('marking it skip or todo fails', async () => {
  for (const edit of [s => s.replace('  test(`the Troubleshooter', '  test.skip(`the Troubleshooter'), s => s.replace('(${kind})`, () =>', '(${kind})`, { skip: true }, () =>'), s => s.replace('  test(`the Troubleshooter', '  test.todo(`the Troubleshooter')]) {
    const r = repo();
    try {
      r.put('tests/offline.test.mjs', edit(TEST));
      const res = await run(r, r.commit());
      assert.equal(res.ok, false); assert.match(res.problems.join('\n'), /skip\/todo/);
    } finally { r.done(); }
  }
});

test('dropping an assertion fails; adding one or editing other tests passes', async () => {
  let r = repo();
  try {
    r.put('tests/offline.test.mjs', TEST.replace(/^    assert\.equal\(card\(\).*\n/m, ''));
    const res = await run(r, r.commit());
    assert.equal(res.ok, false); assert.match(res.problems[0], /lost 1 assertion/);
  } finally { r.done(); }
  r = repo();
  try {
    r.put('tests/offline.test.mjs', TEST.replace("'the real Troubleshooter, not the checks card');", "'the real Troubleshooter, not the checks card');\n    assert.equal(pill(), 'Troubleshoot');")
      .replace("assert.equal(1, 1)", "assert.equal(2, 2)").replace("test('something else', () => { assert.ok(true); });\n", ''));
    const res = await run(r, r.commit());
    assert.equal(res.ok, true, res.problems.join('\n'));
  } finally { r.done(); }
});

test('a copy elsewhere does not hide a weakened original', async () => {
  const r = repo();
  try {
    r.put('tests/copy.test.mjs', TEST);
    r.put('tests/offline.test.mjs', TEST.replace('  test(`the Troubleshooter', '  test.skip(`the Troubleshooter'));
    // One base marker, two head markers: the guard takes the intact copy, so this passes only because the protected
    // assertions still run in full somewhere. Now weaken both.
    assert.equal((await run(r, r.commit())).ok, true);
    r.put('tests/copy.test.mjs', TEST.replace('  test(`the Troubleshooter', '  test.skip(`the Troubleshooter'));
    assert.equal((await run(r, r.commit())).ok, false);
  } finally { r.done(); }
});

test('a malformed new marker fails, a well-formed new one is listed', async () => {
  const r = repo();
  try {
    r.put('tests/new.test.mjs', "// owner-correction: wizard-ux#1 - 15 Nov - It should\ntest('x', () => { assert.ok(1); });\n");
    let res = await run(r, r.commit());
    assert.equal(res.ok, false); assert.match(res.problems[0], /malformed/);
    r.put('tests/new.test.mjs', '// owner-correction: humanitylabs-org/wizard-ux#1 · 2026-11-18 · "Keep it."\ntest(\'x\', () => { assert.ok(1); });\n');
    res = await run(r, r.commit());
    assert.equal(res.ok, true); assert.equal(res.newOnes.length, 1);
  } finally { r.done(); }
});

test('python tests are guarded too', async () => {
  const py = 'import unittest\n\nclass T(unittest.TestCase):\n    pass\n\n# owner-correction: humanitylabs-org/wizard-troubleshooter#37 · 2026-11-08 · "That\'s its sole purpose."\ndef test_repairs():\n    assert repair() == "ok"\n\ndef test_other():\n    assert True\n';
  const r = repo({ 'tests/test_repair.py': py });
  try {
    assert.equal(scan('tests/test_repair.py', py).found[0].asserts.length, 1);
    r.put('tests/test_repair.py', py.replace('def test_repairs', '@unittest.skip("later")\ndef test_repairs'));
    assert.equal((await run(r, r.commit())).ok, false);
  } finally { r.done(); }
});

test('this repo’s own owner-correction markers are well-formed and each guards at least one assertion', () => {
  const root = new URL('..', import.meta.url).pathname;
  const files = execFileSync('git', ['grep', '-l', 'owner-correction:', '--', 'tests'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => f && f !== 'tests/owner-corrections.test.mjs');
  assert.ok(files.length >= 3, 'the backfilled tests carry markers');
  for (const f of files) {
    const { found, malformed } = scan(f, readFileSync(join(root, f), 'utf8'));
    assert.deepEqual(malformed, [], f);
    for (const m of found) assert.ok(m.asserts.length > 0, `${f}:${m.line} guards no assertion`);
  }
});

test('several tests may quote the same words: deleting one names that file, not a neighbour', async () => {
  const other = `import test from 'node:test';\nimport assert from 'node:assert/strict';\n\n${MARK}\ntest('the pill still opens it', () => {\n  assert.equal(pill(), 'open');\n});\n`;
  const r = repo({ 'tests/a.test.mjs': TEST, 'tests/b.test.mjs': other });
  try {
    r.rm('tests/a.test.mjs');
    const res = await run(r, r.commit());
    assert.equal(res.ok, false);
    assert.equal(res.problems.length, 1, res.problems.join('\n'));
    assert.match(res.problems[0], /^tests\/a\.test\.mjs:\d+: .*deleted/);
  } finally { r.done(); }
});

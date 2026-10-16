// Smoke test for the pure helpers in lib/ + the viewed-state EOL behavior in src/core.js.
// Run: node test/smoke.js
'use strict';
const assert = require('assert');
const { lineRef, buildSearchRegex, parseAheadBehind, parseNumstat, parseTodoHunks, eolNormalize, globToRegex } = require('../lib');

// lineRef: single line, multi-line, and the column-0 end (exclusive last line).
assert.strictEqual(lineRef(11, 11, 5), '12', 'single line');
assert.strictEqual(lineRef(11, 17, 5), '12-18', 'multi-line inclusive end');
assert.strictEqual(lineRef(11, 18, 0), '12-18', 'end at col 0 excludes that line');

// buildSearchRegex: literal escapes the dot; regex mode does not; word + case flags.
assert.ok(buildSearchRegex({ value: 'console.log', regex: false, wholeWord: false, caseSensitive: false }).test('x console.log y'));
assert.ok(!buildSearchRegex({ value: 'console.log', regex: false, wholeWord: false, caseSensitive: true }).test('consoleXlog'), 'literal dot must not match any char');
assert.ok(buildSearchRegex({ value: 'a.c', regex: true, wholeWord: false, caseSensitive: true }).test('abc'), 'regex dot matches');
assert.ok(buildSearchRegex({ value: 'foo', regex: false, wholeWord: true, caseSensitive: true }).test('a foo b'));
assert.ok(!buildSearchRegex({ value: 'foo', regex: false, wholeWord: true, caseSensitive: true }).test('foobar'), 'whole word');
assert.ok(buildSearchRegex({ value: 'FOO', regex: false, wholeWord: false, caseSensitive: false }).test('foo'), 'case-insensitive');
assert.throws(() => buildSearchRegex({ value: '(', regex: true }), 'invalid regex throws');

// parseAheadBehind: "behind<TAB>ahead".
assert.deepStrictEqual(parseAheadBehind('0\t3\n'), { behind: 0, ahead: 3 });
assert.deepStrictEqual(parseAheadBehind('2 5'), { behind: 2, ahead: 5 });
assert.strictEqual(parseAheadBehind('garbage'), null);

// parseNumstat: counts keyed by path; binary skipped.
const ns = parseNumstat('5\t2\tsrc/a.js\n-\t-\timg.png\n0\t9\tb.ts\n');
assert.deepStrictEqual(ns.get('src/a.js'), { add: 5, del: 2 });
assert.deepStrictEqual(ns.get('b.ts'), { add: 0, del: 9 });
assert.ok(!ns.has('img.png'), 'binary file excluded');

// parseTodoHunks: the tricky one — new-file line tracking across hunks, only on added lines.
const diff = [
  'diff --git a/foo.js b/foo.js',
  '--- a/foo.js',
  '+++ b/foo.js',
  '@@ -10,0 +11,2 @@',
  '+// TODO: fix this',
  '+const x = 1;',
  '@@ -20 +22 @@',
  '-old line',
  '+// FIXME later',
].join('\n');
const re = /\b(TODO|FIXME)\b/;
const todos = parseTodoHunks(diff, re);
assert.deepStrictEqual(todos, [
  { rel: 'foo.js', line: 11, text: '// TODO: fix this' },
  { rel: 'foo.js', line: 22, text: '// FIXME later' },
], 'TODO at +11, FIXME at +22 (deletion does not advance the new-file counter)');

// Paths with spaces: git appends a trailing TAB to the +++ header — must be stripped or the
// recorded path never matches the review set (real bug: "src/Back End/...").
{
  const spaced = parseTodoHunks('+++ b/src/Back End/Foo.cs\t\n@@ -0,0 +1 @@\n+// TODO: scoped', re);
  assert.deepStrictEqual(spaced, [{ rel: 'src/Back End/Foo.cs', line: 1, text: '// TODO: scoped' }],
    'trailing tab on spaced paths stripped');
}

// TODO_RE: a marker needs a comment leader or a `LABEL:` shape — identifiers like %TEMP% /
// $env:TEMP / `TEMP` in prose flooded the TODO list (real false positives from a PowerShell repo).
{
  const { TODO_RE, todoCol } = require('../lib');
  for (const s of ['%TEMP%\\logs\\x.log', '# Spelled the long way: $env:TEMP is short', '$env:TEMP = $Shell',
    'shell whose `TEMP` is the 8.3 spelling', '# child: TEMP spelled as asked', 'a * TEMP_FACTOR'])
    assert.ok(!TODO_RE.test(s), `not a marker: ${s}`);
  for (const s of ['// TODO fix', '# FIXME: x', '/* HACK */', ' * NOTE: y', '<!-- WIP -->', 'x(); // TODO(rob): later', '- NOTE: md'])
    assert.ok(TODO_RE.test(s), `marker: ${s}`);
  assert.strictEqual(todoCol('x(); // TODO: y'), 8, 'column points at the keyword, not the leader');
}

// Claude review file: branch-scoped, order dedups + keeps notes, lines 1→0-based, bad entries skipped;
// delete matches by file+line+body; relocate follows the anchor text when code moves.
{
  const { parseClaudeReview, removeClaudeComments, relocate } = require('../lib');
  const text = JSON.stringify({
    branch: 'feat',
    order: ['src/a.js', { file: '.\\src\\b.js', note: 'callers' }, 'src/a.js'],
    comments: [
      { file: 'src/a.js', line: 3, endLine: 5, anchor: '  const x = 1;  ', kind: 'big-picture', body: '- why' },
      { file: 'src/a.js', line: 0, body: 'bad line' },
      { file: 'src/b.js', line: 2, body: '' },
    ],
  });
  assert.strictEqual(parseClaudeReview(text, 'other'), null, 'other branch → hidden');
  const r = parseClaudeReview(text, 'feat');
  assert.deepStrictEqual([...r.order], [['src/a.js', { i: 0, note: '' }], ['src/b.js', { i: 1, note: 'callers' }]]);
  assert.deepStrictEqual(r.comments, [{ file: 'src/a.js', line: 2, endLine: 4, anchor: 'const x = 1;', body: '- why', big: true }]);
  assert.strictEqual(parseClaudeReview('{nope', 'feat'), null, 'garbage → null');
  const left = JSON.parse(removeClaudeComments(text, r.comments)).comments;
  assert.strictEqual(left.length, 2, 'only the matching note removed');
  assert.strictEqual(relocate(['a', 'b', 'const x = 1;', 'c'], 0, 'const x = 1;'), 2, 'moved line found');
  assert.strictEqual(relocate(['a'], 5, 'gone'), 5, 'missing anchor keeps stored line');
}

// tablesToText: GFM table → aligned fenced block (cells padded, ** / ` stripped); other lines untouched.
{
  const { tablesToText } = require('../lib');
  const out = tablesToText('- intro\n\n| Pick | Checked |\n|---|---|\n| `own` template | **shared**, active |\n| a | b |\n\n- after');
  assert.strictEqual(out, [
    '- intro', '',
    '```text',
    '┌──────────────┬────────────────┐',
    '│ Pick         │ Checked        │',
    '╞══════════════╪════════════════╡',
    '│ own template │ shared, active │',
    '├──────────────┼────────────────┤',
    '│ a            │ b              │',
    '└──────────────┴────────────────┘',
    '```',
    '', '- after',
  ].join('\n'));
  assert.strictEqual(tablesToText('a | b'), 'a | b', 'not a table → unchanged');
}

// Branch tree (terminal picker port): parents from the first-parent walk, trunk fallback, detached roots,
// bottom-up graph lanes with ┘ joins. Stack: main ← feat-a ← {feat-b, feat-c}; orphan has no history.
{
  const { parseBranchTips, parseFirstParents, branchTree, formatBranchGraph, parseWorktrees } = require('../lib');
  const tips = parseBranchTips('b1 feat-b\nc1 feat-c\na1 feat-a\nm1 main\no1 orphan\n'); // newest first
  const fp = parseFirstParents('b1 a1\nc1 a1\na1 m1\nm1\no1\n');
  branchTree({ tips, firstParents: fp, trunks: ['main'], birthOf: async () => 0 }).then((rows) => {
    assert.deepStrictEqual(rows.map((r) => `${r.name}<${r.parent}`), ['orphan<', 'main<', 'feat-a<main', 'feat-b<feat-a', 'feat-c<feat-a']);
    const g = formatBranchGraph([...rows].reverse(), 'main', ['main']);
    assert.deepStrictEqual(g, ['◯   ', '│ ◯ ', '◯─┘ ', '◉   ', '◇   '], 'lanes: fork joins its parent with ┘, orphan is ◇');
  }).then(() => {
    // Same-tip tie: fresh child at its parent's commit → the OLDER branch is the parent.
    const t2 = parseBranchTips('x1 child\nx1 parent\nm1 main\n');
    const fp2 = parseFirstParents('x1 m1\nm1\n');
    return branchTree({ tips: t2, firstParents: fp2, trunks: ['main'], birthOf: async (b) => ({ parent: 1, child: 2, main: 0 }[b]) });
  }).then((rows) => {
    assert.strictEqual(rows.find((r) => r.name === 'child').parent, 'parent', 'same tip: older branch is the parent');
    assert.strictEqual(rows.find((r) => r.name === 'parent').parent, 'main');
  }).catch((e) => { console.error(e); process.exit(1); });
  const wt = parseWorktrees('worktree C:/core\nHEAD aa\nbranch refs/heads/x\n\nworktree C:/worktrees/US-1/core\nHEAD bb\nbranch refs/heads/y\n', 'C:\\core');
  assert.deepStrictEqual([...wt], [['y', 'core']], 'other worktrees only, by folder name');
}

// globToRegex: ignore-pattern semantics — ** crosses slashes, * doesn't, /-containing anchors to path.
{
  const m = (pat, rel) => { const re = globToRegex(pat); return !!re && re.test(rel); };
  assert.ok(m('*.g.cs', 'src/Gen/Foo.g.cs'), 'extension glob matches basename anywhere');
  assert.ok(!m('*.g.cs', 'src/Gen/Foo.cs'), 'extension glob is exact');
  assert.ok(m('migrations', 'db/migrations/001.sql'), 'bare name matches any path segment');
  assert.ok(m('**/migrations/**', 'db/migrations/001.sql'), '** crosses folders');
  assert.ok(m('package-lock.json', 'package-lock.json'), 'root file');
  assert.ok(!m('src/*.js', 'src/deep/a.js'), 'single * does not cross slashes');
  assert.ok(m('src/**/*.js', 'src/deep/deeper/a.js'), '** in the middle');
  assert.strictEqual(globToRegex('   '), null, 'blank pattern → null');
}

// eolNormalize: CRLF / lone CR → LF, everything else byte-preserved.
assert.deepStrictEqual(eolNormalize(Buffer.from('a\r\nb\r\n')), Buffer.from('a\nb\n'), 'CRLF → LF');
assert.deepStrictEqual(eolNormalize(Buffer.from('a\rb')), Buffer.from('a\nb'), 'lone CR → LF');
assert.deepStrictEqual(eolNormalize(Buffer.from('a\nb\n')), Buffer.from('a\nb\n'), 'LF untouched');
assert.deepStrictEqual(eolNormalize(Buffer.from('a\r\r\nb')), Buffer.from('a\n\nb'), 'CR then CRLF');
assert.deepStrictEqual(
  eolNormalize(Buffer.from([0xff, 0x00, 0x0d, 0x0a, 0xf0, 0x9f, 0x8e, 0x89])),
  Buffer.from([0xff, 0x00, 0x0a, 0xf0, 0x9f, 0x8e, 0x89]),
  'non-EOL bytes (binary / UTF-8) byte-preserved'
);
assert.ok(
  eolNormalize(Buffer.from('x\r\ny')).equals(eolNormalize(Buffer.from('x\ny'))),
  'CRLF and LF variants normalize identically'
);

// Integration: the branch swap-and-back scenario against the real fileHash/isViewed (vscode stubbed).
// A file marked viewed as LF must STAY viewed after git rewrites it as CRLF (autocrlf), and vice versa.
{
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = (r, p, m) => (r === 'vscode'
    ? { EventEmitter: class { get event() { return () => {}; } fire() {} }, workspace: {}, window: {}, commands: {}, Uri: {}, RelativePattern: class {} }
    : origLoad(r, p, m));
  const core = require('../src/core.js');
  Module._load = origLoad;

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vetty-eol-'));
  const rel = 'a.js';
  const p = path.join(dir, rel);
  const write = (text, mtime) => {
    fs.writeFileSync(p, text);
    fs.utimesSync(p, mtime, mtime); // distinct mtimes so the hash cache can't mask a real change
  };

  // Mark viewed while the file is LF (how AI tools write it)…
  write('const x = 1;\nconst y = 2;\n', new Date(2026, 0, 1));
  const viewed = { [rel]: { h: core.fileHash(dir, rel), b: null } };
  assert.ok(core.isViewed(dir, viewed, rel), 'viewed right after marking');

  // …swap branches and back: git rewrites the file with CRLF (autocrlf). Same content, new EOLs+mtime.
  write('const x = 1;\r\nconst y = 2;\r\n', new Date(2026, 0, 2));
  assert.ok(core.isViewed(dir, viewed, rel), 'STAYS viewed after a CRLF rewrite (the swap-back bug)');

  // A real edit still re-flags it unviewed.
  write('const x = 999;\r\nconst y = 2;\r\n', new Date(2026, 0, 3));
  assert.ok(!core.isViewed(dir, viewed, rel), 'real change re-flags unviewed');

  // Migration: an old-format mark (raw-bytes hash, pre-normalization) still counts and self-heals.
  const crypto = require('crypto');
  write('old mark era\r\n', new Date(2026, 0, 4));
  const legacy = { [rel]: { h: crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'), b: null } };
  assert.ok(core.isViewed(dir, legacy, rel), 'old-format (raw) mark still viewed');
  assert.strictEqual(legacy[rel].h, core.fileHash(dir, rel), 'old-format mark self-heals to the new format');

  // Deletion tombstone: a mark on a deleted file counts as viewed while the file stays gone,
  // and re-flags unviewed if the file comes back.
  const goneRel = 'gone.js';
  return core.viewedEntry(dir, goneRel).then((entry) => {
    assert.deepStrictEqual(entry, { h: 'D', b: null }, 'deleted file gets the D tombstone');
    const tomb = { [goneRel]: entry };
    assert.ok(core.isViewed(dir, tomb, goneRel), 'tombstone viewed while file is gone');
    fs.writeFileSync(path.join(dir, goneRel), 'resurrected\n');
    assert.ok(!core.isViewed(dir, tomb, goneRel), 'tombstone unviewed once the file returns');
    fs.rmSync(dir, { recursive: true, force: true });
    return ownIndexWritesAreSuppressed();
  });
}

// `git diff` refreshes the index's stat cache and WRITES .git/index — and load() runs six of them.
// The .git watcher fires on that write and schedules a reload, which runs the reads again: an
// endless ~400ms refresh loop. (--no-optional-locks stops this for `status` but NOT for `diff`.)
// core.isSelfIndexWrite is what breaks it, so both its directions are pinned here.
function ownIndexWritesAreSuppressed() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const Module = require('module');
  const { execFileSync } = require('child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vetty-locks-')));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  const clean = () => fs.rmSync(dir, { recursive: true, force: true });
  const idxUri = { fsPath: path.join(dir, '.git', 'index') };

  // A fresh core whose workspace is the temp repo (resolveRepoRoot needs a folder to look at).
  delete require.cache[require.resolve('../src/core.js')];
  const origLoad = Module._load;
  Module._load = (r, p, m) => (r === 'vscode'
    ? {
        EventEmitter: class { get event() { return () => {}; } fire() {} },
        workspace: { workspaceFolders: [{ uri: { fsPath: dir } }], getConfiguration: () => ({ get: (_k, d) => d }) },
        window: {}, commands: {}, Uri: {}, RelativePattern: class {},
      }
    : origLoad(r, p, m));
  const core = require('../src/core.js');
  Module._load = origLoad;

  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.js'), 'x\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  let bump = 0;
  const dirty = () => {
    // Same content, DISTINCT new mtime → the index's stat cache is stale, so the next read
    // rewrites it. Distinct matters: reusing one timestamp leaves the index already matching,
    // and the read then writes nothing.
    const t = new Date(Date.now() + 4000 * ++bump);
    fs.utimesSync(path.join(dir, 'a.js'), t, t);
  };

  return core.resolveRepoRoot()
    .then(() => {
      dirty();
      return core.git(dir, ['diff', '--name-status', 'HEAD']);
    })
    .then(() => {
      assert.ok(core.isSelfIndexWrite(idxUri), "vetty's own index write must not schedule a reload");
      // An index write vetty did NOT make still counts as news.
      dirty();
      execFileSync('git', ['diff', '--name-status', 'HEAD'], { cwd: dir, stdio: 'pipe' });
      assert.ok(!core.isSelfIndexWrite(idxUri), 'an external index write must still schedule a reload');
      // HEAD is never suppressed, whatever the index looks like.
      assert.ok(!core.isSelfIndexWrite({ fsPath: path.join(dir, '.git', 'HEAD') }), 'HEAD is never suppressed');
      clean();
      console.log('ok — all smoke checks passed');
    })
    .catch((e) => {
      clean();
      throw e;
    });
}

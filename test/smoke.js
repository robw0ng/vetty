// Smoke test for the pure helpers in lib/ + the viewed-state EOL behavior in src/ (via core).
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
    return newerMergeBaseWins().then(() => fastReadsMatchOldCommands()).then(() => refFileReadsMatchGit()).then(() => ownIndexWritesAreSuppressed());
  });
}

// mergeBaseRef: of the local base and origin/<base>, the merge-base nearer HEAD wins.
async function newerMergeBaseWins() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const Module = require('module');
  const { execFileSync } = require('child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vetty-base-')));
  const origin = path.join(root, 'origin.git');
  const dir = path.join(root, 'work');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  const clean = () => fs.rmSync(root, { recursive: true, force: true });
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(__dirname, '..', 'src'))) delete require.cache[k];
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
  const commit = (name) => {
    fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
    g(dir, 'add', '-A');
    g(dir, 'commit', '-qm', name);
    return g(dir, 'rev-parse', 'HEAD');
  };
  try {
    g(root, 'init', '-q', '--bare', '-b', 'master', origin);
    g(root, 'clone', '-q', origin, dir);
    g(dir, 'config', 'user.email', 't@t');
    g(dir, 'config', 'user.name', 't');
    const one = commit('one');
    g(dir, 'push', '-q', 'origin', 'master');
    g(dir, 'checkout', '-q', '-b', 'feat');
    commit('feat');
    assert.strictEqual(await core.mergeBaseRef(dir, 'master'), one, 'equal → local merge-base');
    // 1. stale local: upstream moved on and feat merged it; local master never pulled
    g(dir, 'checkout', '-q', 'master');
    const up = commit('upstream');
    g(dir, 'push', '-q', 'origin', 'master');
    g(dir, 'reset', '-q', '--hard', one);
    g(dir, 'checkout', '-q', 'feat');
    g(dir, 'merge', '-q', '--no-edit', 'origin/master');
    assert.strictEqual(await core.mergeBaseRef(dir, 'master'), up, "stale local → origin's merge-base");
    // 2. stale origin: local master gets a commit feat then merges; origin not fetched
    g(dir, 'checkout', '-q', 'master');
    g(dir, 'merge', '-q', '--ff-only', 'origin/master');
    const loc = commit('local-ahead');
    g(dir, 'checkout', '-q', 'feat');
    g(dir, 'merge', '-q', '--no-edit', 'master');
    assert.strictEqual(await core.mergeBaseRef(dir, 'master'), loc, "stale origin → local's merge-base");
    // 3. diverged: origin master gets its own commit (via a second clone), feat merges both sides
    const other = path.join(root, 'other');
    g(root, 'clone', '-q', origin, other);
    g(other, 'config', 'user.email', 't@t');
    g(other, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(other, 'remote-only.txt'), 'r\n');
    g(other, 'add', '-A');
    g(other, 'commit', '-qm', 'remote-only');
    g(other, 'push', '-q', 'origin', 'master');
    g(dir, 'fetch', '-q', 'origin');
    g(dir, 'merge', '-q', '--no-edit', 'origin/master');
    const mbOrigin = g(dir, 'merge-base', 'origin/master', 'HEAD');
    const mbLocal = g(dir, 'merge-base', 'master', 'HEAD');
    assert.notStrictEqual(mbOrigin, mbLocal, 'setup: merge-bases differ');
    assert.strictEqual(await core.mergeBaseRef(dir, 'master'), mbOrigin, "diverged → origin's merge-base");
    // 4. no upstream ref at all → local
    assert.strictEqual(await core.mergeBaseRef(dir, 'feat'), g(dir, 'rev-parse', 'HEAD'), 'no origin/feat → local merge-base');
    clean();
  } catch (e) {
    clean();
    throw e;
  }
}


// vscode stand-in rich enough for DiffTree: real EventEmitter/TreeItem shapes, everything else a
// callable, constructible proxy. `dir` is the single workspace folder.
function fakeVscode(dir) {
  const h = { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : mk(String(k))) };
  const mk = (name) => new Proxy(function () { return new Proxy({ __name: name }, h); }, h);
  const enumish = (names) => Object.fromEntries(names.map((n, i) => [n, i]));
  return new Proxy({
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: enumish(['None', 'Collapsed', 'Expanded']),
    CommentThreadCollapsibleState: enumish(['Collapsed', 'Expanded']),
    CommentMode: enumish(['Editing', 'Preview']),
    ThemeIcon: class { constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(v = '') { this.value = v; } appendMarkdown(s) { this.value += s; return this; } appendText(s) { this.value += s; return this; } },
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file', with: () => ({ fsPath: p }) }), parse: (s) => ({ fsPath: s, scheme: 'x', query: '' }) },
    RelativePattern: class {},
    workspace: {
      workspaceFolders: [{ uri: { fsPath: dir } }],
      getConfiguration: () => ({ get: (_k, d) => d }),
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidChangeTextDocument: () => ({ dispose() {} }),
      textDocuments: [],
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {} }),
      visibleTextEditors: [], onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      setStatusBarMessage() {}, showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
    },
    commands: { executeCommand: async () => {} },
    comments: { createCommentController: () => ({ createCommentThread: (uri, range, comments) => ({ uri, range, comments, dispose() {} }), dispose() {} }) },
    env: { clipboard: { writeText: async () => {} } },
  }, h);
}
function fakeContext() {
  const m = new Map();
  const store = { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()] };
  return { subscriptions: [], workspaceState: store, globalState: store, globalStorageUri: { fsPath: require('os').tmpdir() } };
}
/** A fresh src/ with vscode stubbed for `dir`. The stub stays installed (load() lazy-requires views)
 *  until the returned restore() runs. */
function freshSrc(dir) {
  const Module = require('module');
  const path = require('path');
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(__dirname, '..', 'src'))) delete require.cache[k];
  const origLoad = Module._load;
  const vs = fakeVscode(dir);
  Module._load = (r, p, m) => (r === 'vscode' ? vs : origLoad(r, p, m));
  const core = require('../src/core.js');
  const tree = require('../src/tree.js');
  return { core, tree, vs, restore: () => { Module._load = origLoad; } };
}

// Perf path vs the commands it replaced. The refresh used to run `diff --name-status`, `diff --numstat`,
// `diff --cached --name-only`, `diff --name-only` and `ls-files --others` on every load; the fast path
// must list the same files in the same order with the same letters, counts and stage/dirty flags.
// Expected values here come from those original commands, run directly against the fixture.
async function fastReadsMatchOldCommands() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vetty-fast-')));
  const g = (...a) => execFileSync('git', ['-c', 'core.quotePath=false', ...a], { cwd: dir, stdio: 'pipe' }).toString();
  const w = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);
  const lines = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean);
  const clean = () => fs.rmSync(dir, { recursive: true, force: true });
  const { core, tree, restore } = freshSrc(dir);
  try {
    g('init', '-q', '-b', 'master');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    for (const f of ['a.txt', 'b.txt', 'del.txt', 'old.txt', 'sp ace.txt', 'rev.txt', 'keep.txt', 'ws.txt'])
      w(f, `${f}\n1\n2\n3\n`);
    fs.writeFileSync(path.join(dir, 'bin.png'), Buffer.from([0x89, 0x50, 0, 1, 2]));
    g('add', '-A');
    g('commit', '-qm', 'base');
    g('checkout', '-q', '-b', 'feat');
    // Committed on the branch: modify, add, delete, rename, binary, spaces, a later-reverted file,
    // and a whitespace-only change (the -w numstat read stays separate but must still agree).
    w('a.txt', 'a.txt\n1\nX\n3\n');
    w('new.txt', 'n\n// TODO: new\n');
    fs.rmSync(path.join(dir, 'del.txt'));
    g('mv', 'old.txt', 'moved.txt');
    fs.writeFileSync(path.join(dir, 'bin.png'), Buffer.from([0x89, 0x50, 0, 9, 9, 9]));
    w('sp ace.txt', 'sp ace.txt\n1\n2\n3\n4 // FIXME: spaced\n');
    w('rev.txt', 'rev.txt\nchanged\n');
    w('ws.txt', 'ws.txt\n1 \n2\n3\n'); // trailing space only — invisible to `diff -w`
    g('add', '-A');
    g('commit', '-qm', 'feat');
    const feat = g('rev-parse', 'HEAD').trim();
    // Working tree: staged-clean, staged-then-edited, dirty-only, staged new file, untracked,
    // and rev.txt put back to base content (differs from HEAD, not from the merge-base → wtOnly).
    w('b.txt', 'b.txt\nstaged\n');
    g('add', 'b.txt');
    w('keep.txt', 'keep.txt\nstaged\n');
    g('add', 'keep.txt');
    w('keep.txt', 'keep.txt\nstaged\nthen edited\n');
    w('a.txt', 'a.txt\n1\nX\n3\n// HACK dirty\n');
    w('s.txt', 's\n');
    g('add', 's.txt');
    w('u.txt', 'u\n// TODO: untracked\n');
    w('rev.txt', 'rev.txt\n1\n2\n3\n');

    const ctx = fakeContext();
    core.app.context = ctx;
    await core.resolveRepoRoot();
    await core.setBaseFor(ctx, 'feat', 'master');
    const t = new tree.DiffTree(ctx);
    core.app.diffTree = t;

    // What the old reads say, for both ranges.
    const expect = (ref) => {
      const files = [];
      const status = new Map();
      const addNS = (text, keep) => {
        for (const line of text.split('\n')) {
          const parts = line.split('\t');
          if (parts.length < 2) continue;
          const rel = parts[parts.length - 1].trim();
          if (!rel || !keep(rel)) continue;
          files.push(rel);
          status.set(rel, parts[0].trim()[0]);
        }
      };
      addNS(g('diff', '--name-status', ref), () => true);
      const stat = new Map();
      const num = (out, keep) => {
        for (const line of out.split('\n')) {
          const m = line.match(/^(\d+)\t(\d+)\t(.+)$/);
          if (m && keep(m[3].trim())) stat.set(m[3].trim(), { add: +m[1], del: +m[2] });
        }
      };
      num(g('diff', '--numstat', ref), () => true);
      const realChanged = new Set(lines(g('diff', '-w', '--numstat', ref)).map((l) => l.split('\t')[2].trim()));
      const untracked = lines(g('ls-files', '--others', '--exclude-standard'));
      for (const u of untracked) if (!status.has(u)) (files.push(u), status.set(u, 'U'));
      const staged = new Set(lines(g('diff', '--cached', '--name-only')));
      const dirty = new Set(lines(g('diff', '--name-only')));
      const staleStaged = new Set([...dirty].filter((r) => staged.has(r)));
      const wtOnly = new Set();
      const keep = new Set([...staged, ...dirty].filter((r) => !status.has(r)));
      if (ref !== 'HEAD' && keep.size) {
        addNS(g('diff', '--name-status', 'HEAD'), (r) => keep.has(r) && !status.has(r) && (wtOnly.add(r), true));
        num(g('diff', '--numstat', 'HEAD'), (r) => wtOnly.has(r));
      }
      return { files, status, stat, realChanged, untracked, staged, dirty, staleStaged, wtOnly };
    };
    const same = (label, got, want) => assert.deepStrictEqual(got instanceof Map || got instanceof Set ? [...got].sort() : got, want instanceof Map || want instanceof Set ? [...want].sort() : want, label);
    const check = async (label, ref) => {
      await t.load(true);
      assert.strictEqual(t.listRef, ref, `${label}: listRef`);
      const e = expect(ref);
      same(`${label}: files (order)`, t.files, e.files);
      same(`${label}: status`, t.status, e.status);
      same(`${label}: staged`, t.staged, e.staged);
      same(`${label}: dirty`, t.dirty, e.dirty);
      same(`${label}: staleStaged`, t.staleStaged, e.staleStaged);
      same(`${label}: wtOnly`, t.wtOnly, e.wtOnly);
      same(`${label}: untracked`, t.untracked, e.untracked);
      same(`${label}: added`, t.added, [...e.status].filter(([, l]) => l === 'A' || l === 'U').map(([r]) => r).sort());
      same(`${label}: deleted`, t.deleted, [...e.status].filter(([, l]) => l === 'D').map(([r]) => r).sort());
      for (const [rel, v] of e.stat) assert.deepStrictEqual(t.stat.get(rel), v, `${label}: counts for ${rel}`);
      assert.deepStrictEqual(t.stat.get('u.txt'), { add: 2, del: 0 }, `${label}: untracked line count`);
      if (t.hideWhitespace) same(`${label}: realChanged`, t.realChanged, e.realChanged);
      // TODO scan: the markers on added lines + untracked files, as `diff -U0` found them.
      const todos = await core.findTodos(dir, ref, t.untracked, t.todoPatch);
      const want = [];
      for (const [rel, hit] of [['a.txt', '// HACK dirty'], ['new.txt', '// TODO: new'], ['sp ace.txt', '4 // FIXME: spaced'], ['u.txt', '// TODO: untracked']])
        if (e.status.has(rel) || rel === 'u.txt') want.push(`${rel}:${hit}`);
      same(`${label}: todos`, todos.map((x) => `${x.rel}:${x.text}`).sort(), want.sort());
      return e;
    };
    const mb = g('merge-base', 'master', 'HEAD').trim();
    let e = await check('branch range', mb);
    assert.ok(e.wtOnly.has('rev.txt') && e.staleStaged.has('keep.txt') && e.staged.has('b.txt') && e.status.get('moved.txt') === 'R' && e.status.get('del.txt') === 'D',
      'fixture covers rename/delete/staged/stale/wtOnly');
    t.hideWhitespace = true;
    e = await check('branch range, hide whitespace', mb);
    assert.ok(e.realChanged.size && !e.realChanged.has('ws.txt'), 'fixture covers a whitespace-only file');
    t.hideWhitespace = false;
    await ctx.workspaceState.update('vetty.diffRange', 'commit');
    await check('commit range', 'HEAD');
    await ctx.workspaceState.update('vetty.diffRange', 'branch');

    // In-flight guard: a burst of load() calls = the running one + ONE queued rerun that every
    // mid-run caller shares (and that sees state changed during the first run).
    {
      const runs = [];
      const orig = t._load.bind(t);
      t._load = () => { runs.push(1); return orig(); };
      const p1 = t.load();
      const p2 = t.load();
      const p3 = t.load();
      w('late.txt', 'late\n');
      t.markUntrackedStale();
      assert.notStrictEqual(p1, p2, 'second call does not share the running load');
      assert.strictEqual(p2, p3, 'mid-run callers share one queued rerun');
      await Promise.all([p1, p2, p3]);
      assert.strictEqual(runs.length, 2, 'three calls → two runs');
      assert.ok(t.files.includes('late.txt'), 'the queued rerun saw the file created mid-run');
      t._load = orig;
      fs.rmSync(path.join(dir, 'late.txt'));
    }
    // Untracked scan reuse: an edit to an existing file must NOT rescan; create/delete (or a manual
    // refresh) must. Observed through what the tree lists.
    await t.load(true);
    w('u2.txt', 'late\n');
    await t.load(); // a plain reload (contents changed) keeps the last list
    assert.ok(!t.files.includes('u2.txt'), 'untracked list reused on a contents-only reload');
    t.markUntrackedStale(); // what the watcher does on create/delete
    await t.load();
    assert.ok(t.files.includes('u2.txt'), 'untracked list rescanned after a create');
    fs.rmSync(path.join(dir, 'u2.txt'));
    await t.load(true); // the Refresh button
    assert.ok(!t.files.includes('u2.txt'), 'manual refresh rescans');
    assert.strictEqual(g('rev-parse', 'HEAD').trim(), feat, 'fixture HEAD untouched by the reads');
  } finally {
    restore();
    clean();
  }
}


// Ref reads from .git files vs what git says, in every layout that changes where the answer lives:
// loose refs, packed-refs, a detached HEAD, a linked worktree (HEAD in the worktree's git dir, refs
// in the common dir). And the merge-base memo: a repeat refresh with nothing moved spawns no git at
// all; a moved tip or HEAD does.
async function refFileReadsMatchGit() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const cp = require('child_process');
  const { promisify } = require('util');
  const { execFileSync } = require('child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vetty-refs-')));
  const dir = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  const clean = () => fs.rmSync(root, { recursive: true, force: true });
  // Count git spawns: git.js promisifies cp.execFile at load, so wrap before the fresh require.
  let spawns = 0;
  const origExecFile = cp.execFile;
  const counted = function (...a) { spawns++; return origExecFile(...a); };
  counted[promisify.custom] = (...a) => { spawns++; return origExecFile[promisify.custom](...a); };
  cp.execFile = counted;
  const { core, vs, restore } = freshSrc(dir);
  try {
    g(root, 'init', '-q', '-b', 'master', dir);
    g(dir, 'config', 'user.email', 't@t');
    g(dir, 'config', 'user.name', 't');
    const commit = (cwd, name) => {
      fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name}\n`);
      g(cwd, 'add', '-A');
      g(cwd, 'commit', '-qm', name);
      return g(cwd, 'rev-parse', 'HEAD');
    };
    const one = commit(dir, 'one');
    g(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'feat');
    core.app.context = fakeContext();
    await core.resolveRepoRoot();
    const same = async (label) => {
      assert.strictEqual(await core.currentBranch(dir), g(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), `${label}: current branch`);
      assert.strictEqual(core.headRef()?.sha, g(dir, 'rev-parse', 'HEAD'), `${label}: HEAD sha`);
      assert.strictEqual(core.refTip('refs/heads/master'), g(dir, 'rev-parse', 'refs/heads/master'), `${label}: master tip`);
      assert.strictEqual(await core.mergeBaseRef(dir, 'master'), g(dir, 'merge-base', 'master', 'HEAD'), `${label}: merge-base`);
    };
    spawns = 0;
    await core.currentBranch(dir);
    assert.strictEqual(spawns, 0, 'current branch read from .git/HEAD, no spawn');
    await same('loose refs');
    assert.strictEqual(core.refTip('refs/remotes/origin/master'), null, 'missing ref → null (no upstream)');
    g(dir, 'pack-refs', '--all');
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'refs', 'heads', 'master')), 'setup: master is packed');
    await same('packed-refs');
    // Memo: same HEAD + tips → no spawn; a new commit on the base → recomputed.
    spawns = 0;
    assert.strictEqual(await core.mergeBaseRef(dir, 'master'), one, 'memo hit');
    assert.strictEqual(spawns, 0, 'repeat merge-base with nothing moved spawns no git');
    g(dir, 'checkout', '-q', 'master');
    const two = commit(dir, 'two');
    g(dir, 'checkout', '-q', 'feat');
    g(dir, 'merge', '-q', '--no-edit', 'master');
    assert.strictEqual(fs.readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8').includes(one), true, 'setup: packed-refs still holds the old master');
    assert.strictEqual(core.refTip('refs/heads/master'), two, 'loose ref wins over the packed one');
    assert.strictEqual(await core.mergeBaseRef(dir, 'master'), two, 'moved tip → recomputed');
    assert.ok(spawns > 0, 'a moved tip spawns git');
    // Detached HEAD: --abbrev-ref says HEAD; the sha is the commit itself.
    g(dir, 'checkout', '-q', two);
    await same('detached HEAD');
    g(dir, 'checkout', '-q', 'feat');
    // A tag named like the branch: --abbrev-ref says `heads/feat`; the file read must defer to git.
    g(dir, 'tag', 'feat');
    assert.strictEqual(await core.currentBranch(dir), g(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'tag/branch name clash → same as git');
    g(dir, 'tag', '-d', 'feat');
    // Linked worktree: its HEAD lives in .git/worktrees/<name>, refs in the main .git.
    g(dir, 'worktree', 'add', '-q', '-b', 'wtb', wt, 'master');
    vs.workspace.workspaceFolders[0].uri.fsPath = wt;
    await core.resolveRepoRoot();
    assert.strictEqual(core.getCwd(), fs.realpathSync(wt), 'setup: cwd is the worktree');
    spawns = 0;
    assert.strictEqual(await core.currentBranch(wt), 'wtb', 'worktree: current branch from its own HEAD');
    assert.strictEqual(spawns, 0, 'worktree: no spawn for the branch name');
    assert.strictEqual(core.headRef()?.sha, g(wt, 'rev-parse', 'HEAD'), 'worktree: HEAD sha');
    assert.strictEqual(core.refTip('refs/heads/feat'), g(wt, 'rev-parse', 'refs/heads/feat'), 'worktree: shared refs via commondir');
    assert.strictEqual(await core.mergeBaseRef(wt, 'master'), g(wt, 'merge-base', 'master', 'HEAD'), 'worktree: merge-base');
    // Unborn branch (fresh repo): no sha to read → falls back to git, which errors → '' as before.
    const empty = path.join(root, 'empty');
    g(root, 'init', '-q', '-b', 'master', empty);
    vs.workspace.workspaceFolders[0].uri.fsPath = empty;
    await core.resolveRepoRoot();
    assert.strictEqual(core.headRef()?.sha, null, 'unborn: no sha');
    assert.strictEqual(await core.currentBranch(empty), '', 'unborn: same answer as before (git errors → empty)');
  } finally {
    cp.execFile = origExecFile;
    restore();
    clean();
  }
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
  // core is an aggregator, so every cached src module has to go, not just core.js.
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(__dirname, '..', 'src'))) delete require.cache[k];
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

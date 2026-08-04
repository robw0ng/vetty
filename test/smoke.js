// Smoke test for the pure helpers in lib.js + the viewed-state EOL behavior in src/core.js.
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
    console.log('ok — all smoke checks passed');
  });
}

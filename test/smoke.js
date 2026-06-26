// Smoke test for the pure helpers in lib.js. Run: node test/smoke.js
'use strict';
const assert = require('assert');
const { lineRef, buildSearchRegex, parseAheadBehind, parseNumstat, parseTodoHunks } = require('../lib');

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

console.log('ok — all smoke checks passed');

// Pure helpers — no `vscode` dependency, so they're unit-testable with plain node (see test/smoke.js).
'use strict';

/** 1-based "12" or "12-18" for a 0-based range. A range ending at column 0 doesn't include that line. */
function lineRef(sLine, eLine, eChar) {
  const last = eChar === 0 && eLine > sLine ? eLine : eLine + 1; // 1-based last included line
  const start = sLine + 1;
  return start === last ? `${start}` : `${start}-${last}`;
}

/** Build the text-search matcher from the search box + toggles. Throws on an invalid regex. */
function buildSearchRegex(m) {
  let src = m.value;
  if (!m.regex) src = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // literal: escape regex metachars
  if (m.wholeWord) src = `\\b${src}\\b`;
  return new RegExp(src, m.caseSensitive ? '' : 'i');
}

/** Parse `git rev-list --left-right --count B...HEAD` → { behind, ahead } (left=B, right=HEAD). */
function parseAheadBehind(out) {
  const [behind, ahead] = String(out).trim().split(/\s+/).map(Number);
  return Number.isFinite(behind) && Number.isFinite(ahead) ? { behind, ahead } : null;
}

/** Parse `git diff --numstat` → Map(rel → { add, del }). Binary files ("-\t-\t…") are skipped. */
function parseNumstat(out) {
  const map = new Map();
  for (const line of String(out).split('\n')) {
    const m = line.match(/^(\d+)\t(\d+)\t(.+)$/);
    if (m) map.set(m[3].trim(), { add: +m[1], del: +m[2] });
  }
  return map;
}

/** Parse `git diff -U0` output for marker matches on ADDED lines, tracking new-file line numbers. */
function parseTodoHunks(out, re) {
  const todos = [];
  let rel = null;
  let newLine = 0;
  for (const line of String(out).split('\n')) {
    if (line.startsWith('+++ ')) {
      rel = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('---')) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (line.startsWith('+')) {
      const content = line.slice(1);
      if (rel && re.test(content)) todos.push({ rel, line: newLine, text: content.trim() });
      newLine++; // added lines advance the new-file counter; '-' lines don't (and -U0 has no context)
    }
  }
  return todos;
}

module.exports = { lineRef, buildSearchRegex, parseAheadBehind, parseNumstat, parseTodoHunks };

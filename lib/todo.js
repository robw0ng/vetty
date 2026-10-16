// TODO markers: the marker regex and the diff-hunk scanner that finds them on added lines.
'use strict';

// Case-sensitive (uppercase) so prose words like "note"/"bug" don't false-positive — and a bare
// uppercase word isn't enough either: `%TEMP%`, `$env:TEMP`, `` `TEMP` `` are identifiers, not
// markers. A marker counts only (1) right after a comment leader (`// TODO`, `# FIXME`, `/* HACK`,
// a block-comment `* NOTE` line, `<!-- WIP`, `-- XXX`, `; BUG`), or (2) as a `TODO:` / `TODO(me):`
// label not glued to a path/variable ($ % . : \ / - or a word char before it). Group 1 or 2 = marker.
const TODO_WORDS = 'TODO|FIXME|HACK|XXX|BUG|NOTE|OPTIMIZE|REVIEW|WIP|TEMP|REFACTOR|DEPRECATED';
const TODO_RE = new RegExp(
  `(?:(?:^|\\s)(?:\\/\\/+|#+|\\/\\*+|<!--|--|;+)\\s*|^\\s*\\*+\\s*)(${TODO_WORDS})\\b` +
    `|(?<![\\w$%.:\\\\/-])(${TODO_WORDS})(?:\\([^)]*\\))?:`
);

/** Column of the marker keyword in `text`, or -1 if the line holds no marker. */
function todoCol(text) {
  const m = TODO_RE.exec(text);
  if (!m) return -1;
  return m.index + m[0].indexOf(m[1] ?? m[2]);
}

/** Parse `git diff -U0` output for marker matches on ADDED lines, tracking new-file line numbers. */
function parseTodoHunks(out, re) {
  const todos = [];
  let rel = null;
  let newLine = 0;
  for (const line of String(out).split('\n')) {
    if (line.startsWith('+++ ')) {
      // Git appends a trailing TAB to the header when the path contains spaces (GNU patch compat) —
      // without stripping it, the recorded path never matches the review set.
      rel = line.slice(4).replace(/^b\//, '').replace(/[\t\r]+$/, '');
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

module.exports = { TODO_RE, todoCol, parseTodoHunks };

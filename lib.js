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

// TODO markers. Case-sensitive (uppercase) so prose words like "note"/"bug" don't false-positive —
// and a bare uppercase word isn't enough either: `%TEMP%`, `$env:TEMP`, `` `TEMP` `` are identifiers,
// not markers. A marker counts only (1) right after a comment leader (`// TODO`, `# FIXME`, `/* HACK`,
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

/** EOL-normalize a Buffer (CRLF / lone CR → LF), byte-lossless otherwise. Content hashes built on
 *  this survive autocrlf checkout round-trips that flip a file's line endings. */
function eolNormalize(buf) {
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) {
      out[n++] = 0x0a;
      if (buf[i + 1] === 0x0a) i++; // CRLF → one LF
    } else {
      out[n++] = buf[i];
    }
  }
  return out.subarray(0, n);
}

/** Ignore-pattern glob → RegExp: `**` crosses slashes, `*`/`?` don't; a pattern containing `/`
 *  anchors to the repo-relative path, otherwise it matches any path segment. null if malformed. */
function globToRegex(pattern) {
  const p = String(pattern).trim();
  if (!p) return null;
  const DS = String.fromCharCode(1); // placeholder so `**` survives the `*` rewrite
  const src = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, DS)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(DS)
    .join('.*');
  try {
    return new RegExp(p.includes('/') ? `^${src}$` : `(^|/)${src}(/|$)`);
  } catch {
    return null;
  }
}

// --- Claude review file (<git-dir>/vetty/claude-review.json) — written by any Claude session ---
// { branch?, order: [ "path" | { file, note } ], comments: [ { file, line, endLine?, anchor?, kind?, body } ] }
// kind: "big-picture" = the file's one-line role in the whole branch (labelled as such).
// Paths are repo-root-relative; lines are 1-based in the file, 0-based once parsed.
const cleanRel = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '');

/** Parse the review file → { order: Map(rel → { i, note }), comments: [{ file, line, endLine, anchor, body }] }.
 *  null when unparseable or written for a different branch. */
function parseClaudeReview(text, branch) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  if (j.branch && branch && j.branch !== branch) return null;
  const order = new Map();
  for (const e of Array.isArray(j.order) ? j.order : []) {
    const file = cleanRel(typeof e === 'string' ? e : e?.file);
    if (file && !order.has(file)) order.set(file, { i: order.size, note: String((typeof e === 'object' && e?.note) || '') });
  }
  const comments = [];
  for (const c of Array.isArray(j.comments) ? j.comments : []) {
    const file = cleanRel(c?.file);
    const line = parseInt(c?.line, 10);
    if (!file || !(line >= 1) || !c?.body) continue;
    const end = Math.max(line, parseInt(c.endLine, 10) || line);
    const big = c.kind === 'big-picture';
    comments.push({ file, line: line - 1, endLine: end - 1, anchor: String(c.anchor ?? '').trim(), body: String(c.body), big });
  }
  // Staleness: the skill records the HEAD it annotated and when (both optional, older files lack them).
  const head = typeof j.head === 'string' ? j.head.trim() : '';
  const writtenAt = Date.parse(j.writtenAt) || 0;
  return { order, comments, head, writtenAt };
}

/** "just now" / "12m ago" / "3h ago" / "2d ago" for a ms timestamp; '' for 0. */
function ago(ms, now = Date.now()) {
  if (!ms) return '';
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/** Review-file text with the given parsed comments removed (matched by file + line + body). */
function removeClaudeComments(text, gone) {
  const j = JSON.parse(text);
  const key = (file, line, body) => `${cleanRel(file)}\n${line}\n${body}`;
  const drop = new Set(gone.map((c) => key(c.file, c.line + 1, c.body)));
  j.comments = (j.comments || []).filter((c) => !drop.has(key(c?.file, parseInt(c?.line, 10), String(c?.body))));
  return JSON.stringify(j, null, 2) + '\n';
}

/** Box-drawn grid: a border around every cell and a rule between every row, so both rows and
 *  columns are easy to tell apart. `cells` = rows of strings (first = header), `w` = column widths. */
function gridLines(cells, w) {
  const rule = (l, m, r, h = '─') => l + w.map((wk) => h.repeat(wk + 2)).join(m) + r;
  const row = (r) => '│' + w.map((wk, k) => ` ${(r[k] || '').padEnd(wk)} `).join('│') + '│';
  const lines = [rule('┌', '┬', '┐')];
  cells.forEach((r, i) => {
    if (i) lines.push(i === 1 ? rule('╞', '╪', '╡', '═') : rule('├', '┼', '┤')); // double rule under the header
    lines.push(row(r));
  });
  lines.push(rule('└', '┴', '┘'));
  return lines;
}

/** Markdown tables → aligned monospace blocks. VS Code's comment widget renders GFM tables with no
 *  borders or cell padding (columns run together); a fenced block keeps them readable. Inline `code`
 *  and ** marks are dropped inside cells — a code block would show them literally. */
function tablesToText(md) {
  const lines = String(md).split('\n');
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('-');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!(isRow(lines[i]) && isSep(lines[i + 1] ?? ''))) {
      out.push(lines[i]);
      continue;
    }
    const rows = [lines[i]];
    let j = i + 2;
    while (j < lines.length && isRow(lines[j])) rows.push(lines[j++]);
    const cells = rows.map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/\*\*|`/g, '')));
    const w = [...Array(Math.max(...cells.map((r) => r.length)))].map((_, k) => Math.max(...cells.map((r) => (r[k] || '').length)));
    out.push('```text', ...gridLines(cells, w), '```');
    i = j - 1;
  }
  return out.join('\n');
}

/** Re-find a line by its trimmed text: stored line if it still matches, else the nearest match, else stored. */
function relocate(lines, stored, anchor) {
  if (!anchor) return stored;
  if (lines[stored]?.trim() === anchor) return stored;
  for (let d = 1; d < lines.length; d++) {
    if (lines[stored + d]?.trim() === anchor) return stored + d;
    if (lines[stored - d]?.trim() === anchor) return stored - d;
  }
  return stored;
}

module.exports = { parseClaudeReview, removeClaudeComments, relocate, tablesToText, ago, lineRef, buildSearchRegex, parseAheadBehind, parseNumstat, parseTodoHunks, eolNormalize, globToRegex, TODO_RE, todoCol };

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

// --- Branch tree (port of the terminal picker's tree / parent / graph routines) ---
// Git stores no parent, so infer it: walk a branch's FIRST-parent history from its tip; the first
// commit holding another branch's tip is the fork point. First-parent, because a merge's second
// parent is someone else's history — merging main in must not make main the base. Several branches
// at one commit (or at our own tip: a freshly stacked branch) are told apart by reflog birth: the
// parent is the one created most recently BEFORE us.

/** `for-each-ref --format='%(objectname) %(refname:short)'` → { at: Map(sha → [names]), names: [] }. */
function parseBranchTips(text) {
  const at = new Map();
  const names = [];
  for (const l of String(text).split('\n')) {
    const i = l.indexOf(' ');
    if (i < 1) continue;
    const sha = l.slice(0, i);
    const name = l.slice(i + 1).trim();
    if (!name) continue;
    if (!at.has(sha)) at.set(sha, []);
    at.get(sha).push(name);
    names.push(name);
  }
  return { at, names };
}

/** `log --first-parent --format='%H %P'` → Map(sha → first parent sha | null). */
function parseFirstParents(text) {
  const next = new Map();
  for (const l of String(text).split('\n')) {
    const p = l.trim().split(' ');
    if (p[0]) next.set(p[0], p[1] || null);
  }
  return next;
}

/** The parent rule. `birthOf(name)` → reflog birth (number; Infinity when unknown), memoized by the caller. */
async function findBranchParent(name, tip, next, branchAt, birthOf, maxAhead) {
  let c = tip;
  for (let d = 0; c && d < maxAhead; d++) {
    const here = branchAt.get(c);
    if (here) {
      const hit = here.filter((b) => b !== name);
      if (hit.length === 1 && d > 0) return hit[0];
      if (hit.length) {
        const mine = await birthOf(name);
        let best = null;
        let bestBorn = -Infinity;
        for (const b of hit) {
          const born = await birthOf(b);
          if (born < mine && born > bestBorn) (bestBorn = born), (best = b);
        }
        if (best) return best;
        if (d > 0) return hit[0];
      }
    }
    c = next.get(c) ?? null;
  }
  return null;
}

/** Local branches as a tree: rows { name, parent } depth-first, siblings newest-first; detached
 *  roots (no trunk in their history) come before the trunk so a bottom-up list puts them under it. */
async function branchTree({ tips, firstParents, trunks, birthOf, maxAhead = 500 }) {
  const { at: branchAt, names } = tips;
  const tipOf = new Map();
  for (const [sha, ns] of branchAt) for (const n of ns) tipOf.set(n, sha);
  const births = new Map();
  const birth = async (b) => {
    if (!births.has(b)) births.set(b, await birthOf(b));
    return births.get(b);
  };
  // Once a trunk moves on, no tip sits on a branch cut from it, so the walk finds no parent: fall
  // back to the trunk — but only one whose history the branch reaches, else it stays a (detached) root.
  const onTrunk = new Map();
  for (const t of trunks) {
    if (!tipOf.has(t)) continue;
    const set = new Set();
    for (let c = tipOf.get(t); c && !set.has(c); c = firstParents.get(c)) set.add(c);
    onTrunk.set(t, set);
  }
  const kids = new Map();
  const roots = [];
  for (const b of tipOf.keys()) {
    let par = await findBranchParent(b, tipOf.get(b), firstParents, branchAt, birth, maxAhead);
    if (!par && !trunks.includes(b)) {
      for (const [t, set] of onTrunk) {
        let c = tipOf.get(b);
        while (c && !set.has(c)) c = firstParents.get(c);
        if (c) {
          par = t;
          break;
        }
      }
    }
    if (par && par !== b) {
      if (!kids.has(par)) kids.set(par, []);
      kids.get(par).push(b);
    } else roots.push(b);
  }
  const order = new Map(names.map((n, i) => [n, i]));
  const rows = [];
  const emit = (name, parent) => {
    rows.push({ name, parent });
    for (const k of (kids.get(name) || []).sort((a, b) => order.get(a) - order.get(b))) emit(k, name);
  };
  roots.sort((a, b) => (trunks.includes(a) - trunks.includes(b)) || order.get(a) - order.get(b));
  for (const r of roots) emit(r, '');
  return rows;
}

/** The graph column, one string per row (rows top to bottom, every child above its parent): lanes
 *  like `git log --graph` — a branch with no lane heading to it opens the leftmost free one; on its
 *  parent's row every lane heading there joins it, ┴ for each but the rightmost, ┘ for that. Nodes
 *  ◉ current / ◯ other; a stack whose root isn't a trunk is detached: ◈ / ◇. Two columns per lane. */
function formatBranchGraph(rows, current, trunks) {
  return layoutBranchGraph(rows, current, trunks).lines;
}

/** Same layout, two outputs: `lines` (text, padded) and `cells` — per row, one entry per text
 *  column: { node?: '◉'|'◯'|'◈'|'◇', up, down, left, right } so a renderer can draw real lines
 *  (box-drawing glyphs come from fallback fonts and don't line up in a webview). */
function layoutBranchGraph(rows, current, trunks) {
  const up = new Map(rows.filter((r) => r.parent).map((r) => [r.name, r.parent]));
  const lanes = []; // each lane: the branch it is heading down to, or null
  const lines = [];
  const cells = [];
  for (const r of rows) {
    let root = r.name;
    const seen = new Set();
    while (up.has(root) && !seen.has(root)) seen.add(root), (root = up.get(root));
    const detached = trunks.length && !trunks.includes(root);
    const node = detached ? (r.name === current ? '◈' : '◇') : r.name === current ? '◉' : '◯';
    const mine = lanes.map((l, i) => (l === r.name ? i : -1)).filter((i) => i >= 0);
    let col;
    if (mine.length) col = mine[0];
    else {
      col = lanes.indexOf(null);
      if (col < 0) (col = lanes.length), lanes.push(null);
    }
    const joins = mine.slice(1);
    const far = joins.length ? joins[joins.length - 1] : col;
    let line = '';
    const row = [];
    for (let i = 0; i < lanes.length; i++) {
      const g = i === col ? node
        : joins.includes(i) ? (i === far ? '┘' : '┴')
        : i > col && i < far ? (lanes[i] ? '┼' : '─')
        : lanes[i] ? '│' : ' ';
      const gap = i >= col && i < far;
      line += g + (gap ? '─' : ' ');
      const c = i === col ? { node, up: mine.length > 0, down: !!r.parent, left: false, right: col < far }
        : joins.includes(i) ? { up: true, down: false, left: true, right: i !== far }
        : i > col && i < far ? { up: !!lanes[i], down: !!lanes[i], left: true, right: true }
        : { up: !!lanes[i], down: !!lanes[i], left: false, right: false };
      row.push(c, { up: false, down: false, left: gap, right: gap });
    }
    for (const j of joins) lanes[j] = null;
    lanes[col] = r.parent || null;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    lines.push(line);
    cells.push(row);
  }
  const w = Math.max(0, ...lines.map((l) => l.length));
  return { lines: lines.map((l) => l.padEnd(w)), cells, width: w };
}

/** `git worktree list --porcelain` → Map(branch → worktree folder name), excluding `cwd` itself. */
function parseWorktrees(text, cwd) {
  const map = new Map();
  let path = '';
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  for (const l of String(text).split('\n')) {
    if (l.startsWith('worktree ')) path = l.slice(9).trim();
    else if (l.startsWith('branch refs/heads/') && path && norm(path) !== norm(cwd))
      map.set(l.slice(18).trim(), path.replace(/[\\/]+$/, '').split(/[\\/]/).pop());
  }
  return map;
}

module.exports = { parseBranchTips, parseFirstParents, findBranchParent, branchTree, formatBranchGraph, layoutBranchGraph, parseWorktrees, parseClaudeReview, removeClaudeComments, relocate, tablesToText, ago, lineRef, buildSearchRegex, parseAheadBehind, parseNumstat, parseTodoHunks, eolNormalize, globToRegex, TODO_RE, todoCol };

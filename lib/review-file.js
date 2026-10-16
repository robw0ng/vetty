// Claude review file (<git-dir>/vetty/claude-review.json) — written by any Claude session, read by
// both editors — plus the text helpers its notes need (relocation, table rendering, "ago").
// { branch?, order: [ "path" | { file, note } ], comments: [ { file, line, endLine?, anchor?, kind?, body } ] }
// kind: "big-picture" = the file's one-line role in the whole branch (labelled as such).
// Paths are repo-root-relative; lines are 1-based in the file, 0-based once parsed.
'use strict';

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

module.exports = { parseClaudeReview, removeClaudeComments, relocate, tablesToText, gridLines, ago };

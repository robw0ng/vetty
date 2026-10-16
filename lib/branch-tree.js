// Branch tree (port of the terminal picker's tree / parent / graph routines).
// Git stores no parent, so infer it: walk a branch's FIRST-parent history from its tip; the first
// commit holding another branch's tip is the fork point. First-parent, because a merge's second
// parent is someone else's history — merging main in must not make main the base. Several branches
// at one commit (or at our own tip: a freshly stacked branch) are told apart by reflog birth: the
// parent is the one created most recently BEFORE us.
'use strict';

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

module.exports = { parseBranchTips, parseFirstParents, findBranchParent, branchTree, layoutBranchGraph, formatBranchGraph, parseWorktrees };

// Base-branch picker: the terminal picker's branch tree in a webview (QuickPick renders in a proportional
// font and can't draw lanes). Trunk at the foot, stacks grow upward, every branch above its parent;
// ◉ you are here, cyan BASE on the inferred parent, ⌂ for branches checked out in other worktrees.
// Type to filter, ↑↓ Enter Esc, click to pick. Resolves to the picked branch or null.
const vscode = require('vscode');
const crypto = require('crypto');
const { layoutBranchGraph } = require('../lib');
const core = require('./core');
const { currentBranch, branchTreeData, defaultBase, lastBranch, TRUNK_NAMES } = core;

let panel = null; // one picker at a time

async function pickBranchTree(context, cwd) {
  if (panel) {
    panel.reveal();
    return null;
  }
  const [cur, tree, inferred] = await Promise.all([currentBranch(cwd), branchTreeData(cwd), defaultBase(cwd)]);
  // Bottom-up: reverse the depth-first rows, then lay lanes top-down over that order.
  const rows = [...tree.rows].reverse();
  // Lanes are drawn as SVG (the box-drawing text comes from fallback fonts and never lines up).
  const { lines, cells } = layoutBranchGraph(rows, cur, TRUNK_NAMES);
  // BASE = what Vetty compares against right now (remembered pick, else the inferred parent). The
  // inferred parent gets no chip of its own: by the time you're here it's just the row below.
  const using = lastBranch(context) || inferred;
  const items = rows.map((r, i) => ({
    name: r.name,
    cells: cells[i],
    noTrunk: /[◇◈]/.test(lines[i]) && !r.parent,
    current: r.name === cur,
    base: r.name === using && r.name !== cur,
    trunk: TRUNK_NAMES.includes(r.name),
    worktree: r.name !== cur ? tree.worktrees.get(r.name) || '' : '',
  }));
  const selected = 0; // cursor starts at the top; the BASE chip alone says what's in use (no double marking)

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      panel?.dispose();
    };
    panel = vscode.window.createWebviewPanel('vettyBranchPick', 'Pick Base Branch', vscode.ViewColumn.Active, {
      enableScripts: true,
    });
    panel.webview.html = html(items, selected);
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === 'pick') finish(m.branch);
      else if (m.type === 'cancel') finish(null);
    });
    // Dismiss on focus loss, like QuickPick — clicking elsewhere shouldn't leave a stray tab.
    panel.onDidChangeViewState((e) => {
      if (!e.webviewPanel.active) finish(null);
    });
    panel.onDidDispose(() => {
      panel = null;
      finish(null);
    });
  });
}

function html(items, selected) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 12px 16px 44px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { font: inherit; font-weight: 600; margin: 0 0 2px; color: var(--vscode-foreground); }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 10px; font-size: 0.9em; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 4px 8px; margin-bottom: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
  input:focus { border-color: var(--vscode-focusBorder); }
  .row { display: flex; align-items: center; white-space: pre; height: 22px; padding: 0 6px; border-radius: 3px; cursor: pointer; }
  .row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .g { display: block; flex: none; margin-right: 6px; }
  .nm.hot { font-weight: 700; }
  .chip { display: inline-block; margin-left: 10px; padding: 0 6px; border-radius: 3px; font-weight: 700; font-size: 0.85em; line-height: 1.5; }
  .tag { margin-left: 10px; color: var(--vscode-descriptionForeground); }
  .hint { position: fixed; left: 0; right: 0; bottom: 0; padding: 8px 22px; color: var(--vscode-descriptionForeground); font-size: 0.9em; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-widget-border, transparent); }
  .empty { color: var(--vscode-descriptionForeground); padding: 6px; }
</style></head><body>
<h1>Pick the base branch</h1>
<p class="sub">Vetty reviews what your branch changed since it. The parent it was cut from is usually right.</p>
<input id="f" type="text" placeholder="Type to filter…" autofocus spellcheck="false">
<div id="list"></div>
<div class="hint" id="hint"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const items = ${data};
  let sel = ${selected};
  let shown = items.map((_, i) => i);
  const f = document.getElementById('f');
  const list = document.getElementById('list');
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // Palette (the terminal picker's palette): hues spread over the circle minus a band around the
  // accent, visited with a stride coprime to n so neighbours differ. Lightness per theme.
  const accent = hueOf(getComputedStyle(document.documentElement).getPropertyValue('--vscode-focusBorder')) || 210;
  const light = matchMedia('(prefers-color-scheme: light)').matches || isLight(getComputedStyle(document.body).backgroundColor);
  const palette = branchPalette(items.length, accent, light ? 0.38 : 0.68);
  function hueOf(css) {
    const m = String(css).trim().match(/^#([0-9a-f]{6})/i);
    if (!m) return 0;
    const r = parseInt(m[1].slice(0, 2), 16) / 255, g = parseInt(m[1].slice(2, 4), 16) / 255, b = parseInt(m[1].slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }
  function isLight(rgb) { const m = String(rgb).match(/\\d+/g); return m && (+m[0] * 299 + +m[1] * 587 + +m[2] * 114) / 1000 > 128; }
  function branchPalette(count, accentHue, L) {
    const n = Math.max(count, 1), band = 64, step = (360 - band) / n, start = (accentHue + band / 2) % 360;
    const hues = Array.from({ length: n }, (_, i) => (start + i * step) % 360);
    let stride = Math.max(Math.floor(n / 2.2), 1);
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    while (stride > 1 && gcd(n, stride) !== 1) stride--;
    const out = []; let idx = 0;
    for (let k = 0; k < n; k++) { out.push('hsl(' + hues[idx].toFixed(0) + ' 95% ' + (L * 100).toFixed(0) + '%)'); idx = (idx + stride) % n; }
    return out;
  }
  const chip = (text, hue) => '<span class="chip" style="background:hsl(' + hue + ' 85% ' + (light ? 88 : 17) + '%);color:hsl(' + hue + ' 70% ' + (light ? 25 : 80) + '%)">' + text + '</span>';
  // Hardcoded, like the terminal picker: you-are-here bright white, BASE cyan — the two rows that must pop.
  const HERE = light ? '#000' : '#fff';
  const BASE = light ? 'hsl(192 100% 32%)' : 'hsl(192 100% 62%)';
  const width = Math.max(1, ...items.map((it) => it.cells.length));

  // One SVG per row: W px per text column, H = row height; rows butt together so verticals join.
  const W = 9, H = 22, R = 4.5, cy = H / 2;
  function svgRow(cells, nodeColor) {
    let lines = '', node = '';
    const L = (x1, y1, x2, y2) => '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/>';
    cells.forEach((c, i) => {
      const x = i * W + W / 2, n = !!c.node;
      if (c.up) lines += L(x, 0, x, n ? cy - R : cy);
      if (c.down) lines += L(x, n ? cy + R : cy, x, H);
      if (c.left) lines += L(i * W, cy, n ? x - R : x, cy);
      if (c.right) lines += L(n ? x + R : x, cy, (i + 1) * W, cy);
      if (n) {
        const filled = c.node === '◉' || c.node === '◈', diamond = c.node === '◇' || c.node === '◈';
        const shape = diamond
          ? '<polygon points="' + x + ',' + (cy - R - 1) + ' ' + (x + R + 1) + ',' + cy + ' ' + x + ',' + (cy + R + 1) + ' ' + (x - R - 1) + ',' + cy + '"'
          : '<circle cx="' + x + '" cy="' + cy + '" r="' + R + '"';
        node += shape + ' style="stroke:' + nodeColor + ';stroke-width:1.5;fill:' + (filled ? nodeColor : 'var(--vscode-editor-background)') + '"/>';
      }
    });
    return '<svg class="g" width="' + width * W + '" height="' + H + '"><g style="stroke:var(--vscode-descriptionForeground);stroke-width:1.5;fill:none;opacity:.7">' + lines + '</g>' + node + '</svg>';
  }

  function render() {
    const q = f.value.trim().toLowerCase();
    shown = items.map((_, i) => i).filter((i) => !q || items[i].name.toLowerCase().includes(q));
    if (!shown.includes(sel)) sel = shown[0] ?? -1;
    list.innerHTML = shown.length ? shown.map((i) => {
      const it = items[i];
      const hot = it.current || it.base;
      const color = it.current ? HERE : it.base ? BASE : palette[i];
      let tag = it.current ? chip('← YOU ARE HERE', 50) : it.base ? chip('CURRENT BASE', 192) : '';
      if (it.trunk) tag += '<span class="tag">(trunk)</span>';
      else if (it.noTrunk) tag += '<span class="tag">(no trunk)</span>';
      if (it.worktree) tag += '<span class="tag" title="checked out in the ' + esc(it.worktree) + ' worktree">⌂ ' + esc(it.worktree) + '</span>';
      return '<div class="row' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' + svgRow(it.cells, color) + '<span class="nm' + (hot ? ' hot' : '') + '" style="color:' + color + '">' + esc(it.name) + '</span>' + tag + '</div>';
    }).join('') : '<div class="empty">No branch matches</div>';
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    // Footer: the keys, plus what Enter means when the highlighted row is your own branch.
    const onSelf = sel >= 0 && items[sel].current;
    document.getElementById('hint').textContent = '↑↓ move · PgUp/PgDn page · Enter ' + (onSelf ? 'review uncommitted changes only' : 'use as base') + ' · Esc close';
  }
  const pick = () => { if (sel >= 0) vscode.postMessage({ type: 'pick', branch: items[sel].name }); };
  f.addEventListener('input', render);
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    const move = (d) => { const p = shown.indexOf(sel); if (shown.length) sel = shown[Math.min(Math.max(p + d, 0), shown.length - 1)]; render(); e.preventDefault(); };
    if (k === 'ArrowDown') move(1); else if (k === 'ArrowUp') move(-1);
    else if (k === 'PageDown') move(10); else if (k === 'PageUp') move(-10);
    else if (k === 'Home') move(-1e9); else if (k === 'End') move(1e9);
    else if (k === 'Enter') { pick(); e.preventDefault(); }
    else if (k === 'Escape') { vscode.postMessage({ type: 'cancel' }); e.preventDefault(); }
    else f.focus();
  });
  list.addEventListener('click', (e) => { const r = e.target.closest('.row'); if (r) { sel = +r.dataset.i; pick(); } });
  // Hover moves the cursor (one highlight, like QuickPick) — no separate hover tint.
  list.addEventListener('mouseover', (e) => {
    const r = e.target.closest('.row');
    if (!r || +r.dataset.i === sel) return;
    list.querySelector('.sel')?.classList.remove('sel');
    sel = +r.dataset.i;
    r.classList.add('sel');
    const onSelf = items[sel].current;
    document.getElementById('hint').textContent = '↑↓ move · PgUp/PgDn page · Enter ' + (onSelf ? 'review uncommitted changes only' : 'use as base') + ' · Esc close';
  });
  render();
  f.focus();
</script></body></html>`;
}

module.exports = { pickBranchTree };

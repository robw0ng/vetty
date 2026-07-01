// The "Search" webview above the Review tree: scope dropdown, name filter, groups filter, and the
// scoped in-panel text search whose results fold into the tree.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildSearchRegex } = require('../lib');
const {
  app, refreshTree, getCwd, getViewed, getIgnored, getGroups, groupNames, isViewed,
} = require('./core');

let searchWebview = null; // set in SearchView.resolveWebviewView; used to push match counts

/** Push "shown of total" file counts to the Search panel. */
function postSearchCounts() {
  if (!searchWebview || !app.diffTree) return;
  const cwd = getCwd();
  if (!cwd || !app.diffTree.base) {
    searchWebview.postMessage({ type: 'counts', shown: 0, total: 0 });
    return;
  }
  const ignored = getIgnored(app.diffTree.context, app.diffTree.base);
  const total = app.diffTree.files.filter((f) => !ignored.has(f)).length;
  searchWebview.postMessage({ type: 'counts', shown: app.diffTree.visibleFiles(cwd).length, total });
  postGroups();
}

/** Push group names (with viewed/total counts) + the active filter to the Search panel dropdown. */
function postGroups() {
  if (!searchWebview || !app.diffTree || !app.diffTree.base) return;
  const cwd = getCwd();
  const map = getGroups(app.diffTree.context, app.diffTree.base);
  const viewed = getViewed(app.diffTree.context, app.diffTree.base);
  const names = groupNames(map);
  const groups = names.map((name) => {
    const files = Object.keys(map).filter((r) => map[r] === name);
    const vw = cwd ? files.filter((f) => isViewed(cwd, viewed, f)).length : 0;
    return { name, total: files.length, viewed: vw };
  });
  const active = (app.diffTree.groupFilter || []).filter((n) => names.includes(n));
  app.diffTree.groupFilter = active.length ? active : null;
  searchWebview.postMessage({ type: 'groups', groups, active });
}

/** Search the shown files (in JS — works for tracked + untracked) and fold results INTO the Review tree. */
function runScopedSearch(m) {
  const cwd = getCwd();
  if (!cwd || !app.diffTree) return;
  app.diffTree.searchMatches = null; // search the filter+scope set, not last run's matches
  const files = app.diffTree.visibleFiles(cwd);
  if (!files.length) {
    vscode.window.showInformationMessage('No files in scope to search.');
    return;
  }
  let re;
  try {
    re = buildSearchRegex(m);
  } catch (e) {
    vscode.window.showErrorMessage(`Invalid regex: ${e.message}`);
    return;
  }
  const matches = new Map();
  let n = 0;
  outer: for (const rel of files) {
    let content;
    try {
      const p = path.join(cwd, rel);
      if (fs.statSync(p).size > 1024 * 1024) continue; // huge file — skip the read (search blocks the host)
      content = fs.readFileSync(p, 'utf8');
    } catch {
      continue; // unreadable
    }
    if (content.indexOf('\0') !== -1) continue; // binary
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const mt = lines[i].match(re); // re has no /g → first match, with .index for highlighting
      if (mt) {
        if (!matches.has(rel)) matches.set(rel, []);
        matches.get(rel).push({ line: i + 1, text: lines[i], col: mt.index, len: mt[0].length });
        if (++n >= 2000) break outer; // safety cap
      }
    }
  }
  app.diffTree.searchMatches = matches;
  app.diffTree.refresh();
  app.diffTree.updateProgress();
  postSearchCounts();
  app.todoTree?.refresh(); // re-slice TODOs to the search results too
  vscode.commands.executeCommand('vettyView.focus'); // stay in the Vetty panel
  if (!matches.size) vscode.window.setStatusBarMessage('No matches in shown files', 2500);
}

/** The "Search" section above the tree: scope dropdown, filename filter, and a scoped text search. */
class SearchView {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true, retainContextWhenHidden: true }; // keep filters within a session
    searchWebview = view.webview;
    const nonce = crypto.randomBytes(16).toString('hex');
    view.webview.html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 8px; }
  .field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
  label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); display: flex; justify-content: space-between; }
  .count { text-transform: none; letter-spacing: 0; opacity: .8; }
  .box { position: relative; }
  input[type="text"] {
    width: 100%; box-sizing: border-box; padding: 4px 6px; font-size: var(--vscode-font-size);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
  }
  input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
  input[type="text"]::placeholder { color: var(--vscode-input-placeholderForeground); }
  select {
    width: 100%; box-sizing: border-box; padding: 4px 6px; font-size: var(--vscode-font-size);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
  }
  select:focus { border-color: var(--vscode-focusBorder); }
  .dropdown { position: relative; }
  .dd-btn {
    width: 100%; box-sizing: border-box; padding: 4px 6px; text-align: left; cursor: pointer;
    display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: var(--vscode-font-size);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
  }
  .dd-btn:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .dd-btn .chev { opacity: .7; }
  .gmenu { flex: 0 0 auto; width: 30px; justify-content: center; }
  .dd-panel {
    position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 5;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555));
    border-radius: 2px; max-height: 160px; overflow-y: auto; padding: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.4);
  }
  .dd-panel[hidden] { display: none; }
  .dd-panel label {
    display: flex; align-items: center; gap: 6px; padding: 3px 4px; cursor: pointer; border-radius: 3px;
    text-transform: none; letter-spacing: 0; font-size: var(--vscode-font-size); color: var(--vscode-foreground);
  }
  .dd-panel label:hover { background: var(--vscode-list-hoverBackground); }
  .dd-panel input { flex: 0 0 auto; width: auto; margin: 0; accent-color: var(--vscode-inputOption-activeBackground); }
  .dd-panel label span { flex: 1; text-align: left; }
  .dd-panel label .gcount { flex: 0 0 auto; opacity: .6; font-size: 11px; }
  .dd-empty { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 4px; }
  #filter { padding-right: 24px; }
  #search { padding-right: 100px; }
  .row { display: flex; gap: 4px; }
  .row .box { flex: 1; }
  .row select { width: auto; flex: 0 0 auto; }
  .clear {
    position: absolute; top: 50%; transform: translateY(-50%); width: 18px; height: 18px;
    display: none; align-items: center; justify-content: center; cursor: pointer; border-radius: 3px;
    opacity: .6; font-size: 13px;
  }
  .clear:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .clear.show { display: inline-flex; }
  #f-clear { right: 4px; }
  #s-clear { right: 80px; }
  .toggles { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; }
  .toggle {
    display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 20px;
    border-radius: 3px; cursor: pointer; user-select: none; font-size: 11px; border: 1px solid transparent;
    color: var(--vscode-input-foreground); opacity: .65;
  }
  .toggle:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .toggle.active {
    opacity: 1; background: var(--vscode-inputOption-activeBackground);
    border-color: var(--vscode-inputOption-activeBorder); color: var(--vscode-inputOption-activeForeground);
  }
</style></head><body>
  <div class="field">
    <label for="filter"><span>Filter by name</span><span class="count" id="count"></span></label>
    <div class="row">
      <div class="box">
        <input id="filter" type="text" placeholder="substring…" />
        <span class="clear" id="f-clear" title="Clear">✕</span>
      </div>
      <select id="scope" title="Scope">
        <option value="all">All</option>
        <option value="unviewed">Unviewed</option>
        <option value="added">Added</option>
        <option value="modified">Modified</option>
      </select>
    </div>
  </div>
  <div class="field">
    <label for="search">Search in shown files</label>
    <div class="box">
      <input id="search" type="text" placeholder="text, then Enter" />
      <span class="clear" id="s-clear" title="Clear">✕</span>
      <div class="toggles">
        <span class="toggle" id="t-case" title="Match Case">Aa</span>
        <span class="toggle" id="t-word" title="Match Whole Word">\\b</span>
        <span class="toggle" id="t-regex" title="Use Regular Expression">.*</span>
      </div>
    </div>
  </div>
  <div class="field" id="group-field">
    <label>Groups <span class="count">none = all</span></label>
    <div class="dropdown" style="display:flex; gap:4px;">
      <button type="button" class="dd-btn" id="group-btn" style="flex:1"><span id="group-label">All groups</span><span class="chev">▾</span></button>
      <button type="button" class="dd-btn gmenu" id="group-menu" title="Group actions">⋯</button>
      <div class="dd-panel" id="group-panel" hidden></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const f = document.getElementById('filter'), s = document.getElementById('search');
    const fClear = document.getElementById('f-clear'), sClear = document.getElementById('s-clear');
    const count = document.getElementById('count');
    const groupBtn = document.getElementById('group-btn'), groupPanel = document.getElementById('group-panel'), groupLabel = document.getElementById('group-label');
    document.getElementById('group-menu').addEventListener('click', () => vscode.postMessage({ type: 'groupMenu' }));
    const esc = (n) => n.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const groupSummary = (a) => (!a.length ? 'All groups' : a.length === 1 ? a[0] : a.length + ' groups');
    const scopeSel = document.getElementById('scope');
    const toggles = { case: document.getElementById('t-case'), word: document.getElementById('t-word'), regex: document.getElementById('t-regex') };
    // Start each session unfiltered (scope/name/search) so a stale filter never silently hides files.
    // Only the match-toggles (case/word/regex) are remembered — they don't hide files.
    const saved = vscode.getState() || {};
    const state = { filter: '', search: '', scope: 'all', case: !!saved.case, word: !!saved.word, regex: !!saved.regex };
    f.value = state.filter; s.value = state.search;
    const save = () => vscode.setState(state);
    const syncUi = () => {
      for (const k of ['case', 'word', 'regex']) toggles[k].classList.toggle('active', !!state[k]);
      scopeSel.value = state.scope;
      fClear.classList.toggle('show', !!f.value);
      sClear.classList.toggle('show', !!s.value);
    };
    const doSearch = () => { if (s.value) vscode.postMessage({ type: 'search', value: s.value, caseSensitive: state.case, wholeWord: state.word, regex: state.regex }); };
    f.addEventListener('input', () => { state.filter = f.value; save(); syncUi(); vscode.postMessage({ type: 'filter', value: f.value }); });
    s.addEventListener('input', () => { state.search = s.value; save(); syncUi(); if (!s.value) vscode.postMessage({ type: 'searchClear' }); });
    s.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    fClear.addEventListener('click', () => { f.value = ''; state.filter = ''; save(); syncUi(); vscode.postMessage({ type: 'filter', value: '' }); f.focus(); });
    sClear.addEventListener('click', () => { s.value = ''; state.search = ''; save(); syncUi(); vscode.postMessage({ type: 'searchClear' }); s.focus(); });
    for (const k of ['case', 'word', 'regex']) toggles[k].addEventListener('click', () => { state[k] = !state[k]; save(); syncUi(); doSearch(); });
    scopeSel.addEventListener('change', () => { state.scope = scopeSel.value; save(); syncUi(); vscode.postMessage({ type: 'scope', value: state.scope }); });
    groupBtn.addEventListener('click', () => { groupPanel.hidden = !groupPanel.hidden; });
    document.addEventListener('click', (ev) => { if (!ev.target.closest('.dropdown')) groupPanel.hidden = true; });
    groupPanel.addEventListener('change', () => {
      const vals = [...groupPanel.querySelectorAll('input:checked')].map((c) => c.value);
      groupLabel.textContent = groupSummary(vals);
      vscode.postMessage({ type: 'groupFilter', value: vals });
    });
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'counts') count.textContent = e.data.total ? (e.data.shown === e.data.total ? e.data.total + ' files' : e.data.shown + ' of ' + e.data.total) : '';
      else if (e.data?.type === 'groups') {
        const groups = e.data.groups || [], active = e.data.active || [];
        groupPanel.innerHTML = groups.length
          ? groups.map((g) => '<label><input type="checkbox" value="' + esc(g.name) + '"' + (active.includes(g.name) ? ' checked' : '') + '><span>' + esc(g.name) + '</span><span class="gcount">' + g.viewed + '/' + g.total + '</span></label>').join('')
          : '<div class="dd-empty">No groups yet</div>';
        groupLabel.textContent = groupSummary(active);
      }
    });
    syncUi();
    vscode.postMessage({ type: 'scope', value: state.scope }); // re-apply persisted scope on (re)load
    if (state.filter) vscode.postMessage({ type: 'filter', value: state.filter });
  </script>
</body></html>`;
    postSearchCounts(); // seed counts + group dropdown now that the webview is live
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'groupMenu') {
        const sel = app.diffTree?.groupFilter || [];
        const scope = sel.length ? (sel.length === 1 ? `"${sel[0]}"` : `${sel.length} selected groups`) : 'a group…';
        const a = await vscode.window.showQuickPick(
          [
            { label: `$(layers) Stage ${scope}`, cmd: 'vetty.stageGroup' },
            { label: `$(go-to-file) Open ${scope}`, cmd: 'vetty.openGroup' },
            { label: `$(eye-closed) Mark ${scope} viewed`, cmd: 'vetty.markGroupViewed' },
            { label: `$(close) Ungroup ${scope}`, cmd: 'vetty.ungroup' },
            { label: '$(clear-all) Ungroup all', cmd: 'vetty.clearGroups' },
          ],
          { placeHolder: sel.length ? `Acting on ${scope}` : 'Group actions (pick a group next)' }
        );
        if (a) vscode.commands.executeCommand(a.cmd);
        return;
      }
      if (m.type === 'filter') {
        app.diffTree.nameFilter = (m.value || '').trim().toLowerCase();
        refreshTree();
      } else if (m.type === 'scope') {
        app.diffTree.scope = m.value || 'all';
        refreshTree();
      } else if (m.type === 'groupFilter') {
        const sel = (Array.isArray(m.value) ? m.value : [m.value]).filter(Boolean);
        app.diffTree.groupFilter = sel.length ? sel : null;
        refreshTree();
      } else if (m.type === 'search' && m.value) {
        runScopedSearch(m); // in-panel results — no swap to VS Code's Search viewlet
      } else if (m.type === 'searchClear') {
        if (app.diffTree?.searchMatches) {
          app.diffTree.searchMatches = null;
          refreshTree();
        }
      }
    });
  }
}

module.exports = { SearchView, postSearchCounts, postGroups, runScopedSearch };

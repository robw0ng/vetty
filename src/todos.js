// The "New TODOs" view: TODO/FIXME markers introduced vs the selected branch, and its copy/open actions.
const vscode = require('vscode');
const path = require('path');
const { todoCol } = require('../lib');
const { app, getCwd, findTodos } = require('./core');
const { fileGroups } = require('./tree');

class TodoTree {
  constructor(context) {
    this.context = context;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.items = [];
  }
  refresh() {
    this._emitter.fire();
  }
  async load() {
    const cwd = getCwd();
    const ref = app.diffTree?.listRef; // honor the active diff mode (branch merge-base vs HEAD)
    this.items = cwd && ref ? await findTodos(cwd, ref) : [];
    this.refresh();
  }
  getTreeItem(el) {
    return el;
  }
  getChildren(el) {
    const cwd = getCwd();
    if (el) {
      return el.todos.map((t) => {
        const msg = t.text.replace(/^\s*(\/\/+|#+|\/\*+|\*+|<!--|--)\s?/, '').replace(/\s*(\*\/|-->)\s*$/, '').trim();
        const it = new vscode.TreeItem(msg || t.text);
        it.description = `:${t.line}`; // the file is the parent row
        it.tooltip = `${t.rel}:${t.line}\n\n${t.text}`;
        it.iconPath = new vscode.ThemeIcon('checklist');
        it.todo = t; // for multi-select copy
        it.contextValue = 'vettyTodo'; // gates the row menu/buttons (the "No TODOs" row has none)
        it.command = { command: 'vetty.openTodo', title: 'Open', arguments: [t.rel, t.line] };
        return it;
      });
    }
    // Slice TODOs by the Review panel's active filter (group / scope / name / search) for a focused view.
    const visible = cwd && app.diffTree ? new Set(app.diffTree.visibleFiles(cwd)) : null;
    const items = visible ? this.items.filter((t) => visible.has(t.rel)) : this.items;
    if (!items.length) {
      const it = new vscode.TreeItem('No TODOs');
      it.iconPath = new vscode.ThemeIcon('check');
      return [it];
    }
    return fileGroups(cwd, items.map((t) => [t.rel, t]), 'todo').map((g) => ((g.todos = g.entries), g));
  }
}

/** TODO entries behind tree rows — a file row stands for all its TODOs. */
function todosOf(items) {
  return items.flatMap((i) => (i?.todo ? [i.todo] : i?.todos || []));
}

/** Ctrl/Cmd+C in the Todos view: copy the selected TODOs as `file:line — text`. */
async function copyTodos() {
  const lines = todosOf(app.todoTreeView?.selection || []).map((t) => `- ${t.rel}:${t.line} — ${t.text.trim()}`);
  if (!lines.length) return;
  await vscode.env.clipboard.writeText(lines.join('\n'));
  vscode.window.setStatusBarMessage(`Copied ${lines.length} TODO(s)`, 2000);
}

/** Right-click "Go to" on a TODO row (row click does the same; this covers the menu). */
async function todoOpenItem(item) {
  if (item?.todo) await openTodo(item.todo.rel, item.todo.line);
}

/** Copy the clicked TODO row (or the multi-selection) as paste-ready bullets. */
async function todoCopyItems(item, sel) {
  const items = Array.isArray(sel) && sel.length ? sel : item ? [item] : [];
  const lines = todosOf(items).map((t) => `- ${t.rel}:${t.line} — ${t.text.trim()}`);
  if (!lines.length) return;
  await vscode.env.clipboard.writeText(lines.join('\n'));
  vscode.window.setStatusBarMessage(`Copied ${lines.length} TODO(s)`, 2000);
}

/** Toolbar: copy ALL currently-shown TODOs (respects the active Review filters) as bullets. */
async function exportTodos() {
  const cwd = getCwd();
  const visible = cwd && app.diffTree ? new Set(app.diffTree.visibleFiles(cwd)) : null;
  const items = (app.todoTree?.items || []).filter((t) => !visible || visible.has(t.rel));
  if (!items.length) {
    vscode.window.showInformationMessage('No TODOs to export.');
    return;
  }
  await vscode.env.clipboard.writeText(items.map((t) => `- ${t.rel}:${t.line} — ${t.text.trim()}`).join('\n') + '\n');
  vscode.window.showInformationMessage(`Copied ${items.length} TODO(s) to the clipboard.`);
}

async function openTodo(rel, line) {
  const cwd = getCwd();
  if (!cwd) return;
  const uri = vscode.Uri.file(path.join(cwd, rel));
  const doc = await vscode.workspace.openTextDocument(uri);
  const l = Math.min(Math.max(line - 1, 0), Math.max(doc.lineCount - 1, 0));
  const text = doc.lineAt(l).text;
  const col = todoCol(text); // highlight the marker → end of line, like a search hit
  const sel = col >= 0 ? new vscode.Range(l, col, l, text.length) : new vscode.Range(l, 0, l, 0);
  await vscode.window.showTextDocument(doc, { selection: sel });
}

module.exports = { TodoTree, copyTodos, todoOpenItem, todoCopyItems, exportTodos, openTodo };

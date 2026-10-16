// Shared singletons wired in activate(), the tree refresh fan-out, and the opt-in debug log.
const vscode = require('vscode');

const REVIEW_KEY = 'vetty.review'; // { original, prBranch, number, repo, headSha } while reviewing a PR
const MAX_OPEN_WITHOUT_CONFIRM = 30;

// Always dereference through `app` (never destructure) — the values are assigned after require time.
const app = {
  context: null, // vscode.ExtensionContext
  diffTree: null,
  diffTreeView: null,
  todoTree: null,
  todoTreeView: null,
  bumpReload: () => {}, // debounced full reload; set in activate
};

function refreshTree() {
  app.diffTree?.refresh();
  app.diffTree?.updateProgress();
  require('./search').postSearchCounts(); // lazy: search requires core at top level
  app.todoTree?.refresh(); // re-slice TODOs to the active filter
  app.commentsTree?.refresh();
}

// Debug log (churn hunting): opt-in via the vetty.debug setting → "Vetty Debug" output channel.
// Logs every git spawn + duration, watcher-triggered refreshes with the file that caused them,
// and per-load summaries.
let debugFlag = false;
let debugChannel = null;
function debugOn() {
  return debugFlag;
}
function updateDebugFlag() {
  debugFlag = vscode.workspace.getConfiguration('vetty').get('debug', false);
}
function dbg(msg) {
  if (!debugFlag) return;
  if (!debugChannel) debugChannel = vscode.window.createOutputChannel('Vetty Debug');
  debugChannel.appendLine(`${new Date().toISOString().slice(11, 23)} ${msg}`);
}
function showDebugLog() {
  if (!debugChannel) debugChannel = vscode.window.createOutputChannel('Vetty Debug');
  debugChannel.show(true);
}

module.exports = { app, refreshTree, debugOn, dbg, updateDebugFlag, showDebugLog, REVIEW_KEY, MAX_OPEN_WITHOUT_CONFIRM };

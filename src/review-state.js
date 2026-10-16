// Persisted per-branch review state: viewed marks (content-hashed), ignored paths, groups, and the
// stage-on-view coupling. Keyed by repo + current branch.
const vscode = require('vscode');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { eolNormalize, globToRegex } = require('../lib');
const { dbg } = require('./app');
const { getCwd, git, gitStdin, gitAddChunked } = require('./git');

/** Content hash of the working file, or '' if unreadable — used to auto-unview a file once it changes.
 *  Cached by (mtime, size): isViewed runs per file per render, so without this every refresh re-reads
 *  and re-hashes the whole changed set from disk. */
const hashCache = new Map(); // rel → { key: 'mtimeMs:size', h, raw }
function fileHash(cwd, rel) {
  try {
    const p = path.join(cwd, rel);
    const st = fs.statSync(p);
    const key = `${st.mtimeMs}:${st.size}`;
    const c = hashCache.get(rel);
    if (c && c.key === key) return c.h;
    // Hash EOL-normalized (CRLF/CR → LF): with autocrlf, a branch swap-and-back rewrites files with
    // flipped line endings — byte-identical content otherwise — which silently unviewed everything.
    // (Rider is immune because it hashes the LF-normalized in-memory document.)
    const buf = fs.readFileSync(p);
    const h = crypto.createHash('sha1').update(eolNormalize(buf)).digest('hex');
    const raw = crypto.createHash('sha1').update(buf).digest('hex'); // pre-normalization format, for mark migration
    hashCache.set(rel, { key, h, raw });
    return h;
  } catch {
    return '';
  }
}
/** Raw (old-format) hash of the file — used once to migrate marks made before EOL normalization. */
function fileHashRaw(cwd, rel) {
  fileHash(cwd, rel); // populates the cache with both
  return hashCache.get(rel)?.raw ?? '';
}

// Viewed marks are per CURRENT BRANCH, stored as { relPath: { h: contentHash, b: gitBlobSha } }. A
// file counts as viewed only while its content still matches `h` (editing it re-flags it unviewed).
// `b` is the snapshot at mark time, used to diff "changes since last review". Legacy entries are
// bare hashes. Branch-keyed, NOT base-keyed: base-keyed marks were shared across sibling branches,
// so marking on one clobbered the other's — and the since-review overlay then diffed against a
// snapshot taken on the sibling (10271-content showing up while reviewing 10270).
let activeBranch = null; // current git branch; set by resolveBase before any tree render
function activeBranchName() {
  return activeBranch;
}
function setActiveBranch(name) {
  activeBranch = name;
}
// Scope = repo + branch ('\n' separator — impossible in both git refs and paths). Repo included so
// two repos in a multi-root workspace sharing a branch name don't share marks. Base param kept as a
// pre-first-load fallback.
function stateScope(base) {
  return `${getCwd() ?? ''}\n${activeBranch || base}`;
}

// Memoize parsed workspaceState values: the getters run per file inside render loops, and the
// per-call copy (spread / new Set) was the hot spot. Callers share the cached object; every
// mutation path calls the matching setter, which keeps cache and storage in sync.
const stateCache = new Map(); // workspaceState key → parsed value

function viewedKey(base) {
  return `vetty.viewed.${stateScope(base)}`;
}
function getViewed(context, base) {
  const k = viewedKey(base);
  if (!stateCache.has(k)) {
    const raw = context.workspaceState.get(k);
    stateCache.set(k, raw && !Array.isArray(raw) ? { ...raw } : {});
  }
  return stateCache.get(k);
}
function setViewed(context, base, map) {
  stateCache.set(viewedKey(base), map);
  return context.workspaceState.update(viewedKey(base), map);
}
function viewedHash(v) {
  return typeof v === 'string' ? v : v?.h; // tolerate legacy bare-hash entries
}
function reviewedBlob(map, rel) {
  const v = map[rel];
  return v && typeof v === 'object' ? v.b : null;
}
function isViewed(cwd, map, rel) {
  const h = viewedHash(map[rel]);
  if (!h) return false;
  if (h === 'D') return !fs.existsSync(path.join(cwd, rel)); // deletion tombstone: viewed while still gone
  const cur = fileHash(cwd, rel);
  if (h === cur) return true;
  // Migration: marks made before EOL-normalized hashing stored the raw-bytes hash. If that still
  // matches, the content is unchanged — self-heal the entry to the new format and keep it viewed.
  if (h === fileHashRaw(cwd, rel)) {
    const v = map[rel];
    if (v && typeof v === 'object') v.h = cur;
    else map[rel] = { h: cur, b: null };
    return true; // persisted on the next setViewed; stateCache keeps it correct within the session
  }
  return false;
}

/** Snapshot the working file into git's object store and return { h, b } for the viewed map.
 *  A DELETED file gets the tombstone hash 'D' (not a valid sha1, can't collide): it counts as
 *  viewed while the file stays gone and re-flags unviewed if the file comes back. */
async function viewedEntry(cwd, rel) {
  if (!fs.existsSync(path.join(cwd, rel))) return { h: 'D', b: null };
  const h = fileHash(cwd, rel);
  let b = null;
  try {
    b = (await git(cwd, ['hash-object', '-w', '--', path.join(cwd, rel)])).trim() || null;
  } catch {
    // blob snapshot best-effort; viewed-ness still works via hash
  }
  return { h, b };
}

/** Snapshot MANY files in ONE git process (bulk mark-viewed) — one process per file via Promise.all
 *  was a process storm on big groups. Falls back per-file if the batch fails (one unreadable path
 *  aborts --stdin-paths entirely). Returns { rel: { h, b } }. */
async function viewedEntries(cwd, rels) {
  const map = {};
  // Deleted files get tombstones and would abort the --stdin-paths batch — split them out first.
  const present = rels.filter((r) => {
    if (fs.existsSync(path.join(cwd, r))) return true;
    map[r] = { h: 'D', b: null };
    return false;
  });
  let blobs = null;
  try {
    blobs = present.length
      ? (await gitStdin(cwd, ['hash-object', '-w', '--stdin-paths'], present.map((r) => path.join(cwd, r)).join('\n') + '\n'))
          .trim()
          .split('\n')
      : [];
    if (blobs.length !== present.length) blobs = null;
  } catch {
    blobs = null;
  }
  if (blobs) {
    present.forEach((rel, i) => (map[rel] = { h: fileHash(cwd, rel), b: blobs[i].trim() || null }));
  } else {
    for (const rel of present) map[rel] = await viewedEntry(cwd, rel);
  }
  return map;
}

// vetty.ignorePatterns: settings-level globs (a layer on top of .gitignore, no repo file) — matches
// land in the Untracked group automatically. `**` crosses slashes, `*`/`?` don't; a pattern with a
// slash anchors to the repo-relative path, without one it matches any path segment.
let ignoreRegexes = null; // recompiled when the setting changes (config listener calls resetIgnorePatterns)
function resetIgnorePatterns() {
  ignoreRegexes = null;
}
function ignoredByPattern(rel) {
  if (!ignoreRegexes) {
    const pats = vscode.workspace.getConfiguration('vetty').get('ignorePatterns', []) || [];
    ignoreRegexes = pats
      .filter((p) => typeof p === 'string')
      .map(globToRegex)
      .filter(Boolean);
  }
  return ignoreRegexes.some((re) => re.test(rel));
}

// Ignored marks are a plain per-branch list of paths — a deliberate exclusion, so (unlike viewed) it
// is not tied to content hash. Ignored files get their own tree group, out of Unviewed/Viewed.
// The Set's `has` also consults vetty.ignorePatterns, so every consumer sees pattern matches as
// ignored; iteration/spread still yields only the explicit per-branch entries (what setIgnored saves).
class IgnoredSet extends Set {
  has(rel) {
    return super.has(rel) || ignoredByPattern(rel);
  }
}
function ignoredKey(base) {
  return `vetty.ignored.${stateScope(base)}`;
}
function getIgnored(context, base) {
  const k = ignoredKey(base);
  if (!stateCache.has(k)) {
    const raw = context.workspaceState.get(k);
    stateCache.set(k, new IgnoredSet(Array.isArray(raw) ? raw : []));
  }
  return stateCache.get(k);
}
function setIgnored(context, base, set) {
  stateCache.set(ignoredKey(base), set);
  return context.workspaceState.update(ignoredKey(base), [...set]);
}

// Groups: a per-branch { relPath: groupName } map. Lets you bucket changed files (by intent) and stage
// a bucket at a time — a lightweight, working-copy-only changelist. Shown as a [name] tag on the row.
function groupsKey(base) {
  return `vetty.groups.${stateScope(base)}`;
}
function getGroups(context, base) {
  const k = groupsKey(base);
  if (!stateCache.has(k)) {
    const raw = context.workspaceState.get(k);
    stateCache.set(k, raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {});
  }
  return stateCache.get(k);
}
function setGroups(context, base, map) {
  stateCache.set(groupsKey(base), map);
  return context.workspaceState.update(groupsKey(base), map);
}
function groupNames(map) {
  return [...new Set(Object.values(map))];
}

/** Opt-in (vetty.stageOnView): marking a file viewed also stages its current content — reviewed ⇒
 *  staged. Files with open comments are skipped: a comment means "changes requested", so the file
 *  is reviewed but not approved (staged = viewed ∧ no open comments). Best-effort; never blocks
 *  the mark. */
async function stageOnView(context, cwd, rels) {
  if (!vscode.workspace.getConfiguration('vetty').get('stageOnView', false)) return;
  const comments = require('./comments').getComments(context); // lazy — comments requires core at top level
  const approved = rels.filter((r) => !(comments[r] || []).length);
  const skipped = rels.length - approved.length;
  if (skipped)
    vscode.window.setStatusBarMessage(
      `Vetty: ${skipped === 1 ? '1 file' : `${skipped} files`} viewed but NOT staged — open comments (💬)`,
      6000
    );
  if (!approved.length) return;
  try {
    await gitAddChunked(cwd, approved); // also stages deletions for tombstoned files
  } catch (e) {
    dbg(`stageOnView failed: ${e.message}`);
  }
}

/** Stage-on-view's symmetric half: with the mode on, unviewing also unstages. Best-effort. */
async function unstageOnUnview(cwd, rels) {
  if (!vscode.workspace.getConfiguration('vetty').get('stageOnView', false)) return;
  try {
    for (let i = 0; i < rels.length; i += 100) await git(cwd, ['restore', '--staged', '--', ...rels.slice(i, i + 100)]);
  } catch {
    // nothing staged / not in HEAD — fine
  }
}

module.exports = {
  hashCache, fileHash, fileHashRaw,
  activeBranchName, setActiveBranch, stateScope, stateCache,
  getViewed, setViewed, viewedHash, reviewedBlob, isViewed, viewedEntry, viewedEntries,
  getIgnored, setIgnored, ignoredByPattern, resetIgnorePatterns,
  getGroups, setGroups, groupNames,
  stageOnView, unstageOnUnview,
};

// Pure parsers for git output and small text helpers — no `vscode` dependency (see test/smoke.js).
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

/** One `git diff --raw --numstat -U0 <ref>` carries the file list, the line counts and the patch.
 *  Raw records (`:mode mode sha sha X\tpath[\tnewpath]`) give the status letter exactly as
 *  `--name-status` did (renames → the new path); the numstat rows parse as before; the patch
 *  starts at the first `diff --git` line (none for an empty diff). */
function parseRawDiff(out) {
  const s = String(out);
  const cut = s.search(/^diff --git /m);
  const head = cut < 0 ? s : s.slice(0, cut);
  const entries = [];
  for (const line of head.split('\n')) {
    if (line[0] !== ':') continue;
    const parts = line.split('\t');
    const rel = parts[parts.length - 1].trim();
    const letter = parts[0].slice(parts[0].lastIndexOf(' ') + 1)[0];
    if (rel && letter) entries.push({ rel, letter });
  }
  return { entries, stat: parseNumstat(head), patch: cut < 0 ? '' : s.slice(cut) };
}

/** `git status --porcelain=v1 -z --untracked-files=no` → the files whose index differs from HEAD
 *  (what `diff --cached --name-only` listed) and whose working tree differs from the index (what
 *  `diff --name-only` listed). An index rename/copy record is followed by its source path; skipped. */
function parsePorcelainZ(out) {
  const staged = [];
  const dirty = [];
  const ents = String(out).split('\0');
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e.length < 4 || e[2] !== ' ') continue;
    const x = e[0];
    const y = e[1];
    const rel = e.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;
    if (x !== ' ' && x !== '?' && x !== '!') staged.push(rel);
    if (y !== ' ' && x !== '?' && x !== '!') dirty.push(rel);
  }
  return { staged, dirty };
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

module.exports = { lineRef, buildSearchRegex, parseAheadBehind, parseNumstat, parseRawDiff, parsePorcelainZ, eolNormalize, globToRegex };

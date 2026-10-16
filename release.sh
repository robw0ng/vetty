#!/usr/bin/env bash
# One-shot release (macOS / Linux twin of release.bat). Run AFTER committing your own work.
#   ./release.sh                 -> notes = commit subjects since the last tag
#   ./release.sh "fix: message"  -> notes = your message
# Does: if there are new commits since the last tag, bump patch in package.json, make ONE release
# commit for that bump, annotated-tag it, push master + tag. The tag push fires the GitHub workflow
# (builds the VSIX + Rider zip, publishes). It never commits YOUR changes -- commit those first.
set -euo pipefail
cd "$(dirname "$0")"

MSG="${1:-}"

# --- last tag + guard: nothing to release if no commits since it ---
LASTTAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -n "$LASTTAG" ] && [ "$(git rev-list "$LASTTAG..HEAD" --count)" = "0" ]; then
  echo "No new commits since $LASTTAG - nothing to release."
  exit 0
fi

# --- bump patch (edits package.json only; no git tag) ---
npm version patch --no-git-tag-version >/dev/null
VER="$(node -p "require('./package.json').version")"
[ -n "$VER" ] || { echo "could not read version"; exit 1; }

# --- notes: arg, else commit subjects since the last tag (excluding release commits) ---
NOTES="$(mktemp)"
if [ -n "$MSG" ]; then
  printf '%s\n' "$MSG" > "$NOTES"
else
  RANGE=""; [ -n "$LASTTAG" ] && RANGE="$LASTTAG..HEAD"
  git log $RANGE --no-merges --grep '^chore(release):' --invert-grep --format='- %s' > "$NOTES"
fi
[ -s "$NOTES" ] || echo "Release v$VER" > "$NOTES"   # never tag with empty notes

echo "Release notes for v$VER:"; cat "$NOTES"; echo

# --- commit the bump, tag, push ---
git add package.json
git commit -m "chore(release): v$VER"
git tag -a "v$VER" -F "$NOTES" || { echo "tag failed (already exists?)"; rm -f "$NOTES"; exit 1; }
rm -f "$NOTES"

echo "Pushing master..."; git push
echo "Pushing tag v$VER..."; git push origin "v$VER"
echo "Done. v$VER pushed - check the Actions tab for the build and Releases for the .vsix + Rider zip."

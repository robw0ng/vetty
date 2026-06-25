# Branch Diff Opener

Opens every file that differs from another git branch.

## Run it (no install)

1. `code C:\Users\RobertWong\branch-diff-opener`
2. Press **F5** → an Extension Development Host window opens with the extension loaded.
3. In that window, open your repo folder, then **Cmd/Ctrl+Shift+P → "Open All Files Changed vs Branch"**.
4. Enter the branch (default `master`), choose **diff** or **files**.

## Install it permanently

```
npm i -g @vscode/vsce
cd C:\Users\RobertWong\branch-diff-opener
vsce package        # produces branch-diff-opener-0.0.1.vsix
code --install-extension branch-diff-opener-0.0.1.vsix
```

## Notes

- Uses `git diff --name-only --diff-filter=d <branch>` — every file differing from that
  branch tip (committed **and** uncommitted), excluding deletes. For "only the commits on my
  branch," change it to `<branch>...HEAD` (three-dot) in `extension.js`.
- "Open as diff" relies on the built-in Git extension's `git:` content provider; "Open files"
  is the dependency-free fallback.

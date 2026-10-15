# Install Vetty

Three parts, each safe to rerun: the Claude plugin (the `vetty-review` skill), the VS Code extension,
and the Rider plugin. An agent can follow this from "install https://github.com/robw0ng/vetty".

## 1. Clone

```powershell
git clone https://github.com/robw0ng/vetty.git C:\vetty
```

Any folder works; the steps below assume `C:\vetty`.

## 2. Claude plugin (the skill)

```powershell
claude plugin marketplace add C:\vetty          # registers the "robert-vetty" marketplace (a directory)
claude plugin install vetty@robert-vetty         # installs the "vetty" plugin → skill `vetty:vetty-review`
```

Rerunning `marketplace add` on an existing name is a no-op; `claude plugin marketplace update robert-vetty`
picks up a newer clone. If a loose copy exists at `~\.claude\skills\vetty-review`, delete it — the
plugin's skill replaces it, and two copies drift.

## 3. VS Code extension

Releases ship a `.vsix`: https://github.com/robw0ng/vetty/releases (asset `vetty-<version>.vsix`).

```powershell
code --install-extension C:\path\to\vetty-<version>.vsix --force
```

Or build it from the clone: `npm install -g @vscode/vsce` once, then `npx @vscode/vsce package -o dist\vetty.vsix`
in `C:\vetty` and install that file. Reload the VS Code window afterwards.

## 4. Rider plugin

Releases ship `vetty-rider-<version>.zip`. Unzip it into every Rider plugins folder you use:

```powershell
foreach ($d in Get-ChildItem "$env:APPDATA\JetBrains\Rider*\plugins" -Directory) {
  Remove-Item -Recurse -Force (Join-Path $d.FullName 'vetty-rider') -ErrorAction SilentlyContinue
  Expand-Archive C:\path\to\vetty-rider-<version>.zip -DestinationPath $d.FullName -Force
}
```

Or build it: `gradle -p C:\vetty\jetbrains buildPlugin` → `jetbrains\build\distributions\vetty-rider-<version>.zip`.
Restart Rider afterwards.

## 5. Verify

- `claude plugin list` shows `vetty@robert-vetty`; in a Claude session, `/vetty:vetty-review` is offered.
- VS Code: `code --list-extensions --show-versions | findstr vetty` → `local.vetty@<version>`; the Vetty
  icon appears in the Activity Bar.
- Rider: Settings ▸ Plugins lists Vetty; the Vetty tool window is on the right.
- End to end: open a branch in VS Code or Rider so Vetty writes `<git-dir>/vetty/scope.json`, ask Claude
  to "annotate this branch for Vetty", then turn on **Guided Review** in Vetty.

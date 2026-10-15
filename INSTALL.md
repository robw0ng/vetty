# Install Vetty

Three parts, each safe to rerun: the Claude plugin (the `vetty-review` skill), the VS Code extension,
and the Rider plugin. An agent can follow this from "install https://github.com/robw0ng/vetty".
Windows and macOS are both covered; the macOS steps are **untested on a real Mac** until Robert tries them.

## 1. Clone

```sh
git clone https://github.com/robw0ng/vetty.git
```

Any folder works. Below, `<clone>` is that folder (e.g. `C:\dev\vetty` on Windows, `~/dev/vetty` on macOS).

## 2. Claude plugin (the skill)

```sh
claude plugin marketplace add <clone>            # registers the "robert-vetty" marketplace (a directory)
claude plugin install vetty@robert-vetty          # installs the "vetty" plugin → skill `vetty:vetty-review`
```

Same on both OSes. Rerunning `marketplace add` on an existing name is a no-op;
`claude plugin marketplace update robert-vetty` picks up a newer clone. If a loose copy exists at
`~/.claude/skills/vetty-review`, delete it — the plugin's skill replaces it, and two copies drift.

## 3. VS Code extension

Releases ship a `.vsix`: https://github.com/robw0ng/vetty/releases (asset `vetty-<version>.vsix`).

```sh
code --install-extension <path to vetty-<version>.vsix> --force
```

macOS: if `code` isn't on PATH, run **Shell Command: Install 'code' command in PATH** from VS Code's
command palette first, or use Extensions ▸ ⋯ ▸ **Install from VSIX…** in the UI. Reload the window afterwards.

Or build it from the clone: `npm install -g @vscode/vsce` once, then in `<clone>`:
`npx @vscode/vsce package -o dist/vetty.vsix` and install that file.

## 4. Rider plugin

Releases ship `vetty-rider-<version>.zip`. The portable way on either OS: Rider ▸ Settings ▸ Plugins ▸
⚙ ▸ **Install Plugin from Disk…** ▸ pick the zip ▸ restart Rider.

Scripted alternative — unzip into Rider's plugins folder (each Rider version has its own; do every one you use):

- Windows: `%APPDATA%\JetBrains\Rider<version>\plugins\`
  ```powershell
  foreach ($d in Get-ChildItem "$env:APPDATA\JetBrains\Rider*\plugins" -Directory) {
    Remove-Item -Recurse -Force (Join-Path $d.FullName 'vetty-rider') -ErrorAction SilentlyContinue
    Expand-Archive <path to vetty-rider-<version>.zip> -DestinationPath $d.FullName -Force
  }
  ```
- macOS: `~/Library/Application Support/JetBrains/Rider<version>/plugins/`
  ```sh
  for d in ~/Library/Application\ Support/JetBrains/Rider*/plugins; do
    rm -rf "$d/vetty-rider" && unzip -oq <path to vetty-rider-<version>.zip> -d "$d"
  done
  ```

Or build it: `gradle -p <clone>/jetbrains buildPlugin` (Gradle 8.10+ and a JDK 17+; macOS: `brew install gradle`)
→ `jetbrains/build/distributions/vetty-rider-<version>.zip`. Restart Rider afterwards.

`release.bat` in the repo is the Windows release script (bump, tag, push); it's not part of installing and has no macOS twin —
on a Mac, tag and push by hand if you ever release from there.

## 5. Verify

- `claude plugin list` shows `vetty@robert-vetty`; in a new Claude session, `/vetty:vetty-review` is offered.
- VS Code: `code --list-extensions --show-versions | grep vetty` (Windows: `findstr vetty`) → `local.vetty@<version>`;
  the Vetty icon appears in the Activity Bar.
- Rider: Settings ▸ Plugins lists Vetty; the Vetty tool window is on the right.
- End to end: open a branch in VS Code or Rider so Vetty writes `<git-dir>/vetty/scope.json`, ask Claude
  to "annotate this branch for Vetty", then turn on **Guided Review** in Vetty.

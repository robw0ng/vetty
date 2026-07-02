@echo off
REM One-shot release. Run AFTER committing your own work.
REM   release.bat                 -> notes = commit subjects since the last tag
REM   release.bat "fix: message"  -> notes = your message
REM Does: bump patch in package.json, make ONE release commit for that bump, annotated-tag it,
REM push master + tag. The tag push fires the GitHub workflow (builds the VSIX + Rider zip, publishes).
REM It never commits YOUR changes -- commit those first; this only commits the version bump.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "MSG=%~1"

REM --- bump patch (edits package.json only; no git tag) ---
call npm version patch --no-git-tag-version >nul 2>&1 || ( echo version bump failed & exit /b 1 )
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VER=%%v"
if "!VER!"=="" ( echo could not read version & exit /b 1 )

REM --- notes: arg, else commit subjects since the last tag (excluding release commits) ---
set "NOTES=%TEMP%\vetty_notes_!VER!.txt"
if not "!MSG!"=="" (
  > "!NOTES!" echo !MSG!
) else (
  set "RANGE="
  for /f "delims=" %%t in ('git describe --tags --abbrev^=0 2^>nul') do set "RANGE=%%t..HEAD"
  git log !RANGE! --no-merges --grep "^chore(release):" --invert-grep --format="- %%s" > "!NOTES!"
)
REM never tag with empty notes
for %%A in ("!NOTES!") do if %%~zA==0 > "!NOTES!" echo Release v!VER!

echo Release notes for v!VER!:
type "!NOTES!"
echo.

REM --- commit the bump, tag, push ---
git add package.json
git commit -m "chore(release): v!VER!" || ( echo release commit failed & del "!NOTES!" & exit /b 1 )
git tag -a v!VER! -F "!NOTES!" || ( echo tag failed ^(already exists?^) & del "!NOTES!" & exit /b 1 )
del "!NOTES!"

echo Pushing master...
git push || ( echo push failed & exit /b 1 )
echo Pushing tag v!VER!...
git push origin v!VER! || ( echo tag push failed & exit /b 1 )

echo Done. v!VER! pushed - check the Actions tab for the build and Releases for the .vsix + Rider zip.
endlocal

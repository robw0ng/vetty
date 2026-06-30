@echo off
REM Push master + tag the current package.json version + push the tag (fires the GitHub release workflow).
REM Run AFTER committing. Usage: release.bat
setlocal
cd /d "%~dp0"

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VER=%%v
if "%VER%"=="" ( echo Could not read version from package.json & exit /b 1 )

echo Pushing master...
git push || ( echo push failed & exit /b 1 )

echo Tagging v%VER%...
git tag v%VER% 2>nul
git push origin v%VER% || ( echo tag push failed ^(tag may already exist on remote^) & exit /b 1 )

echo Done. v%VER% pushed - check the Actions tab for the build and Releases for the .vsix.
endlocal

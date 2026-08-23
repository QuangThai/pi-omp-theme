# Releasing pi-omp-theme

`pi.dev/packages` is an npm-backed catalog, not a second package registry. A public npm package is discovered automatically when its npm metadata contains the `pi-package` keyword. There is no manual upload form.

This repository intentionally uses a manual release process and does not run GitHub Actions.

## Release checklist

1. Confirm npm and GitHub CLI authentication:

   ```bash
   npm whoami
   gh auth status
   ```

2. Update `package.json` and `package-lock.json` together:

   ```bash
   npm version patch --no-git-tag-version
   ```

3. Add the matching version section to `CHANGELOG.md`.
4. Run the complete local gate and inspect the npm artifact:

   ```bash
   npm ci
   npm run check
   npm publish --dry-run
   ```

5. Commit and push the release changes to `main`.
6. Create and push the matching annotated tag, for example `v1.0.1`.
7. Publish from the tagged, clean checkout:

   ```bash
   npm publish
   ```

8. Create a non-prerelease GitHub Release from the same tag with notes derived from `CHANGELOG.md`.
9. Verify the npm dist-tag, tarball, GitHub tag, and install from a clean directory:

   ```bash
   npm dist-tag ls @nguyenquangthai/pi-omp-theme
   pi -e npm:@nguyenquangthai/pi-omp-theme@1.0.1
   ```

Use npm account 2FA for manual publication and keep local credentials out of the repository. Never reuse or move a published version tag. npm versions are immutable; release a new patch if metadata or artifacts need correction.

## pi.dev catalog discovery

The package carries the required `pi-package` keyword and explicit `pi.extensions` / `pi.themes` manifest. The gallery preview is read from `pi.image`.

npm's search index is eventually consistent. A newly published package can be installable from the registry before npm keyword search—and therefore `pi.dev/packages`—returns it. Wait for npm search indexing rather than republishing the same version.

Useful checks:

```bash
npm view @nguyenquangthai/pi-omp-theme@latest keywords pi --json
npm search --json "@nguyenquangthai/pi-omp-theme"
```

Once npm search returns the package, it should appear automatically at <https://pi.dev/packages>.

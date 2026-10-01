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
   npm run test:e2e:readonly-tools
   npm publish --dry-run
   ```

5. Commit and push the release changes to `main`.
6. Create and push the matching annotated tag, for example `v1.0.1`.
7. Create a non-prerelease GitHub Release from the same tag with notes derived from `CHANGELOG.md`.
8. Check workflow runs, check-runs, and commit statuses for the tagged commit. Wait for every configured CI check to pass before publishing. If none exist, record that CI is not configured; do not describe it as a green CI run.
9. Publish from the tagged, clean checkout:

   ```bash
   npm publish
   ```

10. Verify the npm dist-tag, tarball, GitHub tag, and install from a clean directory:

   ```bash
   npm dist-tag ls @nguyenquangthai/pi-omp-theme
   pi -e npm:@nguyenquangthai/pi-omp-theme@1.0.1
   ```

Use npm account 2FA for manual publication and keep local credentials out of the repository. Never reuse or move a published version tag. npm versions are immutable; release a new patch if metadata or artifacts need correction.

## Read-only tools E2E gate

`npm run test:e2e:readonly-tools` builds and packs the current checkout, installs the
artifact alongside Pi **0.99.1** and `pi-hashline-edit-pro` **4.5.1** in a temporary
directory, and runs the actual CLI via RPC. It needs npm registry access for setup,
but makes no external model requests and never uses your Pi settings or credentials.
A local deterministic provider drives `anchor_grep → replace` against a sandbox file;
the suite asserts the declarations delivered to the model and the final file bytes.

The matrix also covers both npm package orders, default/config/CLI opt-in and opt-out,
trusted/untrusted project settings, extension/environment disable gates, invalid
values, explicit tool restrictions, presentation-only reload, Pi reload, and new
sessions. Failures retain logs and `report.json` in the printed sandbox path.

To retain successful evidence, run:

```bash
npm run test:e2e:readonly-tools -- --keep-temp
```

Set `PI_E2E_PI_VERSION` to another exact Pi version to repeat the gate against it.
This is a runtime/tooling gate, not a visual TUI screenshot test or an assessment
of a live model's tool-selection behavior.

## pi.dev catalog discovery

The package carries the required `pi-package` keyword and explicit `pi.extensions` / `pi.themes` manifest. The gallery preview is read from `pi.image`.

npm's search index is eventually consistent. A newly published package can be installable from the registry before npm keyword search—and therefore `pi.dev/packages`—returns it. Wait for npm search indexing rather than republishing the same version.

Useful checks:

```bash
npm view @nguyenquangthai/pi-omp-theme@latest keywords pi --json
npm search --json "@nguyenquangthai/pi-omp-theme"
```

Once npm search returns the package, it should appear automatically at <https://pi.dev/packages>.

# Changelog

All notable changes to this project are documented here.

## [1.0.2] - 2026-08-24

### Added

- Added a host-binding diagnostic to `/pi-omp-theme doctor`. A foreign Pi module binding now emits one warning and safely withholds incompatible core patches instead of failing silently.
- Added 14 focused Grep renderer regression tests and included them in `npm run check`.

### Fixed

- Fixed blank message and tool surfaces for local-checkout installs by shipping the compiled extension as `dist/extensions/pi-omp-theme.ts`. Pi's jiti loader now consistently applies host aliases so the extension patches the running Pi instance instead of a second local module copy.
- Removed the forced full redraw during initial status-line mounting, preventing startup flashes, scrollback clearing, and terminal-position loss.
- Stopped leaked per-tool elapsed timers at agent and session boundaries; interrupted durations now freeze instead of invalidating the TUI every second.
- Made completed-turn collapsing viewport-aware. Visible tool blocks collapse immediately, while off-screen blocks wait for a natural repaint instead of forcing a full transcript redraw.
- Reworked native Grep and semantic bash `grep`/`rg` previews with strict 6/24-row budgets, breadth-first collapsed selection, expanded context, overlap deduplication, robust path/content parsing, truthful truncation status, explicit empty states, quiet grouped gutters, and OSC-8 file/line links.

### Changed

- Updated the Claude preset context status to show a bracketed progress bar, percentage used, and used/total token counts with pipe separators.
- Updated `npm run package:smoke` to load the built entry through jiti with Pi's host aliases and assert the intentional `.ts` entry and exact npm artifact contents.
- Stopped tracking generated `dist/` bundles in Git; the prepack build still generates and includes the extension in the npm artifact.

## [1.0.1] - 2026-08-23

### Changed

- The welcome card now reports the active Pi coding agent version instead of the extension package version.
- Added Pi gallery preview metadata and a 16:9 package image for `pi.dev/packages`.
- Expanded installation verification, update, uninstall, security, and release documentation.
- Hardened package-smoke coverage for gallery metadata, engine compatibility, manifest integrity, and npm artifact contents.

## [1.0.0] - 2026-08-23

### Added

- Initial stable release of `@nguyenquangthai/pi-omp-theme`.
- Claude-style and OMP-style editor/status presets.
- Titanium dark and light themes.
- Responsive status presentation, compact startup UI, boxed tools, adaptive diffs, quiet-call batching, and completed-turn summaries.
- Deterministic typecheck, architecture, build, and package-smoke gates.

### Changed

- Public package metadata, compiled entry, commands, flags, environment variables, configuration namespace, and exported type identifiers use the `pi-omp-theme` identity; the internal source folder is `extension-src/omp-theme` to avoid shadowing the external repository name.
- The OMP rounded editor keeps autocomplete side borders in the same quiet separator color as the surrounding chrome instead of applying an unrelated primary accent.
- The welcome card top border shows the installed package version instead of repeating the extension name.
- The npm artifact ships only the compiled extension, themes, and release documentation.

### Compatibility

- Core compatibility patches remain opt-in.
- Identity mismatches fall back per surface to native Pi rendering.

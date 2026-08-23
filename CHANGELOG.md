# Changelog

All notable changes to this project are documented here.

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

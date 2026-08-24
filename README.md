# @nguyenquangthai/pi-omp-theme

[![npm](https://img.shields.io/npm/v/@nguyenquangthai/pi-omp-theme)](https://www.npmjs.com/package/@nguyenquangthai/pi-omp-theme)
[![license](https://img.shields.io/npm/l/@nguyenquangthai/pi-omp-theme)](LICENSE)

An OMP-inspired visual theme and TUI presentation extension for [Pi](https://pi.dev). It combines Titanium dark/light themes with a coordinated startup view, status line, editor, messages, and tool rendering.

![pi-omp-theme preview](https://raw.githubusercontent.com/QuangThai/pi-omp-theme/main/media/gallery-preview.png)

## Features

- Claude-style and OMP-style editor/status compositions.
- Responsive status segments for model, effort, path, Git, context, usage, cost, time, and session state.
- Compact startup header or optional welcome card.
- Boxed tool rendering, quiet-call batching, adaptive diffs, elapsed time, and completed-turn summaries.
- Optional message/tool compatibility patches with per-surface identity checks and native fallback.
- Titanium dark/light themes, Nerd Font/Unicode/ASCII modes, shimmer, syntax-highlight caching, and session accents.

## Requirements

- Node.js 22.19 or newer.
- Pi 0.83.x or newer. Compatibility patches are probed against the live Pi runtime per surface; unrecognized identities fall back to Pi's native rendering.

## Install

Use Pi's package manager so the extension and themes are registered correctly:

```bash
pi install npm:@nguyenquangthai/pi-omp-theme
```

Running `npm install` alone downloads the package but does not register it with Pi.

### Verify installation

```bash
pi list
pi -p "/pi-omp-theme doctor"
```

`pi list` should include `npm:@nguyenquangthai/pi-omp-theme`. The doctor command reports the active preset, Pi compatibility identity, theme, surface fallbacks, and the host binding (`operational.compatibility.hostBinding.status` must read `bound`).

### Install from a local checkout

```bash
npm ci && npm run build
pi install /path/to/pi-omp-theme
```

The compiled entry is `dist/extensions/pi-omp-theme.ts` on purpose. Pi loads extensions through jiti, which applies the host aliases (`@earendil-works/*` → the running Pi's own modules) while loading the `.ts` entry. A `.js` entry next to a checkout's `node_modules/@earendil-works/pi-coding-agent` can bind the extension to a second copy of Pi and make message/tool decoration silently miss the TUI. Pi 0.84.3+ runs its Node CLI/RPC entrypoints from a bundled runtime and exposes those host modules virtually; the package detects that loader path instead of comparing it with the modular package entry. If the doctor ever reports `hostBinding.status: "foreign"`, the extension was loaded outside Pi's loader; reinstall with `pi install npm:@nguyenquangthai/pi-omp-theme` or rebuild the checkout.

The first launch after a rebuild transpiles the bundle once (a few seconds); jiti caches the result for later launches.

### Update

```bash
pi update npm:@nguyenquangthai/pi-omp-theme
# Or update every installed Pi package:
pi update --extensions
```

Version-pinned installs such as `npm:@nguyenquangthai/pi-omp-theme@1.0.3` remain pinned until explicitly changed.

### Uninstall

```bash
pi remove npm:@nguyenquangthai/pi-omp-theme
```

## Defaults

The shipped configuration uses the `claude` preset with a dock editor, a status row below the editor, compact startup presentation, boxed tools, completed-turn summaries, and the `titanium` theme. Core compatibility patches remain disabled unless explicitly enabled.

## Presets

`claude`, `omp`, `default`, `minimal`, `compact`, `full`, `ascii`, and `native`.

## Configuration

Use the `piOmpTheme` key in Pi's global or trusted project `settings.json`:

```json
{
  "piOmpTheme": {
    "preset": "claude",
    "theme": {
      "autoApply": "titanium"
    },
    "compatibility": {
      "allowCorePatches": false
    }
  }
}
```

Presets coordinate status placement, editor style/frame, separator, and status layout. Keep those fields omitted when you want the preset's complete composition; for example, changing only `preset` to `"omp"` selects the rounded border layout. Explicit values still win, but `/pi-omp-theme doctor` warns when they contradict coordinated preset fields and produce a hybrid UI.

Precedence:

```text
defaults < global settings < trusted project settings < environment < session override
```

Invalid values fall back safely and appear in `/pi-omp-theme doctor`.

### Environment variables

| Variable | Purpose |
|---|---|
| `PI_OMP_THEME_DISABLED=1` | Disable the extension. |
| `PI_OMP_THEME_NERD_FONTS=1\|0` | Force Nerd Font or non-Nerd glyphs. |
| `PI_OMP_THEME_EDITOR=native\|compact\|boxed\|dock` | Override editor style. |
| `PI_OMP_THEME_STATUS=above\|below\|off` | Override status placement/state. |
| `PI_OMP_THEME_THEME=<name\|off>` | Select or disable automatic theme application. |
| `PI_OMP_THEME_OSC11=1\|0` | Override terminal background synchronization. |
| `PI_OMP_THEME_DEBUG=1` | Enable bounded diagnostics. |

### CLI flags

```text
--pi-omp-theme-core-patches
--pi-omp-theme-message-assistant
--pi-omp-theme-message-special-blocks
--pi-omp-theme-tools
--pi-omp-theme-readonly-tools
--pi-omp-theme-ascii
```

### Commands

| Command | Purpose |
|---|---|
| `/pi-omp-theme` | Show active preset and surface state. |
| `/pi-omp-theme on\|off` | Toggle the extension for the current session. |
| `/pi-omp-theme preset <name>` | Apply a preset. |
| `/pi-omp-theme placement above\|below\|border` | Change status placement. |
| `/pi-omp-theme editor <style> [frame]` | Change editor presentation. |
| `/pi-omp-theme startup off\|compact\|overlay` | Change startup presentation. |
| `/pi-omp-theme surface <name> on\|off` | Toggle a surface. |
| `/pi-omp-theme set <path> <JSON>` | Set a validated configuration leaf. |
| `/pi-omp-theme persist global\|project set <path> <JSON>` | Persist a validated setting. |
| `/pi-omp-theme reload` | Reload configuration and affected surfaces. |
| `/pi-omp-theme doctor` | Show capability, conflict, fallback, and config diagnostics. |

## Privacy and security

Pi extensions execute with the user's system permissions. Review the source before installation.

The extension does not implement telemetry. The optional welcome presentation reads bounded local Pi metadata; its recent-session list can derive a short display title from the opening request in local session files. That data is rendered locally and is not transmitted by this package.

## Development

```bash
npm ci
npm run typecheck
npm run depcruise
npm run build
npm run package:smoke
npm run check
```

`npm run check` is also enforced by the npm `prepack` hook.

Releases are published manually to avoid CI billing. The complete maintainer checklist is documented in the [release guide](https://github.com/QuangThai/pi-omp-theme/blob/main/docs/releasing.md).

## License

[MIT](LICENSE). Required notices from incorporated MIT-licensed sources are retained.

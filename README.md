# @nguyenquangthai/pi-omp-theme

[![npm](https://img.shields.io/npm/v/@nguyenquangthai/pi-omp-theme)](https://www.npmjs.com/package/@nguyenquangthai/pi-omp-theme)
[![license](https://img.shields.io/npm/l/@nguyenquangthai/pi-omp-theme)](LICENSE)

An OMP-inspired visual theme and TUI presentation extension for [Pi](https://github.com/earendil-works/pi-mono). It combines Titanium dark/light themes with a coordinated startup view, status line, editor, messages, and tool rendering.

## Features

- Claude-style and OMP-style editor/status compositions.
- Responsive status segments for model, effort, path, Git, context, usage, cost, time, and session state.
- Compact startup header or optional welcome card.
- Boxed tool rendering, quiet-call batching, adaptive diffs, elapsed time, and completed-turn summaries.
- Optional message/tool compatibility patches with per-surface identity checks and native fallback.
- Titanium dark/light themes, Nerd Font/Unicode/ASCII modes, shimmer, syntax-highlight caching, and session accents.

## Requirements

- Node.js 22 or newer.
- Pi 0.83.x or 0.84.x for the recorded compatibility identities. Unmatched patched surfaces fall back to Pi's native rendering.

## Install

```bash
pi install npm:@nguyenquangthai/pi-omp-theme
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
    "preset": "omp",
    "placement": "border",
    "editor": {
      "style": "dock",
      "frame": "rounded"
    },
    "theme": {
      "autoApply": "titanium"
    },
    "compatibility": {
      "allowCorePatches": false
    }
  }
}
```

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

## License

[MIT](LICENSE). Required notices from incorporated MIT-licensed sources are retained.

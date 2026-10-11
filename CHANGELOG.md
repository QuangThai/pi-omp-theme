# Changelog

All notable changes to this project are documented here.

## [1.0.23] - 2026-10-11

### Changed

- **Everything the theme draws now uses the same side margin.** Pi keeps one column clear on each side of the transcript; its `outputPad` setting controls this for messages and tool output, and its `Working...` row and prompt also sit one column in. The theme had set that padding to zero for tool boxes, inline blocks, and markers, and it drew the status row and the `!` bash block from the edge. As a result, some rows started at column 0 and others at column 1.
  - Transcript blocks now follow Pi's `outputPad` on both sides. This covers the inline `●` markers and `⎿` rows, tool boxes in every chrome, custom message blocks, and the `!` bash block. It includes the edit tool, which Pi renders without padding.
  - The status row and the welcome card keep one column on each side, like Pi's working row and prompt.
  - The `Working...` spinner was never drawn by the theme. When the theme's editor is in place, Pi draws its own working row one column in. That row now lines up with everything else instead of looking one column off.
  - The editor frame and rules still run edge to edge, as Pi's do, and clicks map as before. Messages you type are drawn by Pi and keep Pi's layout.
- **Welcome card.**
  - It stops growing at 100 columns and sits on the same one-column margin.
  - There is now one blank row above it; before, there were two above and three below.
  - Its frame uses the same quiet border color as the theme's other boxes.
  - Both columns open and close with a blank row, and the title lines up with the tips.
  - A thin rule separates Tips, Tool providers, and Recent sessions. The rule is inset from the divider and from the frame.
  - Tips fit on one row (`/ commands   ! bash   !! bash, no context`). Keys stand out and meanings are dim.
  - Tool providers list core first, then the others by tool count. Each row shows the tool count and as many tool names as fit, with `+N` for the rest.
  - With more than four providers, the last row reads `+N more` and names the remaining providers. They used to be dropped without notice.
  - Provider names drop the npm scope and the pinned version or git ref: `npm:@scope/pi-teams@0.1.6` shows as `pi-teams`.
  - Long session titles are cut to fit, and their ages share one right-aligned column.
  - The title reads "Welcome back!" only when there is a recent session, and "Welcome!" otherwise. The top border reads `Pi v<version>`.
  - The card keeps a fixed height, so it never forces Pi to replay the screen.
- The README gallery's welcome image and the gallery preview, which is also the pi.dev package image, now show the new card.

## [1.0.22] - 2026-10-11

### Fixed

- **Tables in extension messages: borders took the code color.** With the Titanium themes, a table cell ending in inline code painted the `│` after it, the padding, and the row's right edge in the code color. This showed up in extension messages such as pi-teams results, and in expanded compaction, skill, and branch blocks.
  - Cause: Titanium leaves `customMessageText` empty, which means the terminal's own text color. Pi's Markdown strips the default text style's escape from the end of each inline run, and for an empty color that escape is the same `\x1b[39m` that closes inline code, so the code color stayed open to the end of the row.
  - These blocks no longer pass a default text style when that color is the terminal's own, so inline code keeps its closing escape. Text renders in the same color as before.
  - A colored `customMessageText` is handled exactly as before.
- Messages you type go through Pi's own component, which the theme does not draw. A table cell ending in inline code there still colors its border under Titanium.

## [1.0.21] - 2026-10-11

### Fixed

- Code blocks drawn before Pi finished loading its syntax grammars stayed dim and unhighlighted: after resuming, forking, or switching to a session, its ` ```text ` and ` ```yaml ` blocks (and code in thinking) kept the plain code-block color while Pi without the theme highlights them. Pi registers a few grammars at startup, loads the rest in the background, and repaints; the theme's highlight cache had kept the pre-load fallback and served it to the repaint. Results that match the no-language fallback are no longer cached, so the repaint highlights them; settled highlighted blocks are still served from the cache. Fenced blocks with no language keep Pi's `mdCodeBlock` color by design, as they do without the theme.

### Changed

- The README gallery shows the block Pi brand logo in the welcome card (`media/welcome.png` and the `gallery-preview.png` preview, which is also the pi.dev package image). Only the logo region of each image was redrawn, on the capture's own character grid.

## [1.0.20] - 2026-10-11

### Changed

- The startup logo is the block Pi in its coral, blue, and gold brand colors, in the welcome card and in the compact header on narrow terminals (silhouette and colors as in `@quandev104/pi-style`). It replaces the accent-gradient logo with box-drawing shadows; under `NO_COLOR` it stays plain blocks. The welcome card keeps its size and layout.

### Fixed

- Inline chrome (`messages.assistantMarker` or `messages.thinkingSummary`, both on in the `claude-code` preset): a text block followed by a thinking run, or by a second text block, in the same message no longer paints flush against it (`● Done.` directly above `● Checking…`). Models that interleave reasoning with short text, such as Codex, produce this order; each `●` entry now has the blank row the others have. Other presets keep Pi's spacing.

## [1.0.19] - 2026-10-11

### Fixed

- A `gh pr view` or `gh issue view` body longer than eight lines offered `· Ctrl+O`, but expanding showed nothing more. The body now expands.
- Every list that stops at a short head now opens on Ctrl+O: `ls` and `find` (the tools in boxed and light chrome, and through bash in every chrome), batches of reads and listings, git `status`, `diff --stat`, `show --stat`, `log`, and the commit, pull, merge, and reset cards, and gh pr and issue lists, checks, runs, and the jobs listed by `gh run view` (the `gh run view --job` log frame is unchanged). Collapsed lists look as before plus `· Ctrl+O to expand` on their `… 4 more files` row (inline bash `ls`/`find` carry it on the summary row, like the List and Find tools); expanded lists show up to `tools.maxExpandedLines`.

## [1.0.18] - 2026-10-11

### Added

- `theme.workingTokens`: the working row counts the run's output tokens, `Working... (14s · ↓ 1.2k tokens · Escape to interrupt)`. Streamed text is estimated at about four characters a token until each message reports its real usage.
- `tools.editSummary`: inline file changes read like Claude Code's. An edit opens with `Updated src/auth.ts with 1 addition and 1 removal` above the existing `+1 −1 · 0.2s` row and diff; a write names its file, `Wrote 3 lines to notes/todo.txt · 0.2s`. Narrow rows shorten the sentence to `Updated src/auth.ts` and leave the write's path out rather than cut the run time.
- `messages.interruptHint`: an interrupted turn keeps Pi's notice and adds `· What should the agent do instead?`, both for an answer (`Operation aborted`) and for a tool run (`Error: This operation was aborted`, which is how Pi reports Esc during a tool).
- The `claude-code` preset turns all three on. They are off by default, so other presets render exactly as before, and each only adds to what was shown.

### Fixed

- Ctrl+O no longer promises lines it cannot show. A diff (edit, quick edit, `git diff`) offered it when only unchanged context was folded, and expanding repainted the same rows; an expanded diff now shows all the context it has room for, so Ctrl+O and a click reveal the folded lines. Inline grep offered it when every match was already shown, and compaction, skill, and branch blocks when their body was empty or a single line that fits. An expanded diff past its row budget no longer offers it on its `lines omitted` row.
- Diffs read Pi's `...` row (unchanged lines its edit diff leaves out) as a gap: it no longer shows as a numbered line (`10 ...`) or counts toward `⋯ 3 unchanged lines hidden`, so a short edit diff shows all its context instead of folding two lines behind a hint. A gap between two changes says how many lines it hides.
- Split diffs number the new side correctly after a skipped run, after a change that opens the diff, and across the hunks of a `git diff`; context lines there continued the previous count.
- Boxed grep results and `grep` commands run through bash now offer Ctrl+O on their `… 7 more matches` row, as the other truncated results do.
- On a narrow terminal the expand hint is no longer cut to `Ctrl+O t…`: a row that cannot fit `Ctrl+O to expand` shows the bare key (`· Ctrl+O`) and shortens its own text first, in every chrome (result rows, tree `… more` rows, footers, and the inline turn summary).
- An expanded grep (the tool and `grep`/`rg` through bash) shows up to `tools.maxExpandedLines` rows instead of stopping at 24; collapsed previews keep their six-row cap.
- Inline chrome: `grep`, `rg`, `ls`, and `find` run through bash read like the Grep, List, and Find tools (`● Grep(row in src)`, then `12 matches in 1 file` under the `⎿` gutter, then the tree), and git and gh cards hang under the gutter too. A `git diff` no longer opens a second `⎿` halfway down its block, and an empty one no longer repeats `no changes`.
- `git diff` and `git status` render their cards on Windows with `core.autocrlf` on. Git's `LF will be replaced by CRLF` warnings in the output made the parser fall back to raw text.
- `/reload` left the transcript half-themed: the reloaded copy found the previous copy's core patches still installed and fell back to Pi's native rendering, while the retired copy kept rendering, so restored history could repeat, new tool calls could go missing, and `/pi-omp-theme doctor` reported the surfaces as native. The reloaded copy now takes the patches over, and `widgets.hide` changes apply on `/reload`.

## [1.0.17] - 2026-10-11

### Added

- `widgets.hide`: keep chosen extension widgets off screen, for example `["pi-todo"]` for pi-todo's pinned **Updated Plan** box. The extension keeps running (`/todos` and its tools are unaffected), other widgets are untouched, and the list is empty by default, so nothing changes unless it is set. Needs `compatibility.allowCorePatches`; `/pi-omp-theme doctor` reports it as **Widgets**.

## [1.0.16] - 2026-10-10

### Added

- `claude-code` preset: a Claude Code transcript on top of the `claude` composer. Tool calls render as `● Tool(args)` with a `⎿` result gutter, assistant answers carry a `●` marker, hidden thinking collapses to `● Thought for 6s`, and the working row shows the run time.
- Individual options for the same transcript: `tools.chrome: "inline"`, `messages.assistantMarker`, `messages.thinkingSummary`, and `theme.workingElapsed`. All are off by default; the `claude` and other presets render exactly as before. `/pi-omp-theme set` accepts them and `tools.chrome`.
- Inline forms for the rest of the transcript: compaction, skill, branch, and custom message blocks read `● Compaction · 10K→4K` with their body under the gutter; a user `!command` reads `● ! command` with its output under the gutter.
- Todo checklists: `todos: [{ content, status }]` in a tool's arguments or result details renders as a ☒/☐ checklist (pi-todo's `todo_write`, `todo_update`, and `todo_read` included); cancelled items are struck through. Inline turns keep todo blocks visible instead of folding them into the summary.
- Inline headers summarise list arguments by their labels, so an ask call reads `● Ask User Question(Fix, Scope +1)`; inline custom message blocks are titled by their type (`● Vcc Recall`).
- Golden snapshot tests for every tool surface (boxed, light, and inline at 80 and 36 columns), assistant messages, thinking, special message blocks, and user commands.

### Fixed

- The first paint of a `git diff` result leaked the internal omitted-row marker as a stray row (later repaints were correct).
- Adaptive diff rows whose background had a colour channel of 49 emitted a malformed SGR sequence before the row colour.
- Completed-turn summaries timed read, list, find, and grep calls until the run collapsed instead of until the tool finished, so a run with a long final answer reported seconds of tool time for millisecond reads (for example `7.52s` instead of `0.12s`).
- Read headers no longer show `:1` for whole-file reads or when a provider sends `null` for unset optional arguments.
- Bash results no longer show Pi's literal `(no output)` as output or count it as words; the empty state reads as such.
- Write previews no longer number an empty line after a final newline.
- Turn summaries read as one sentence (`Read 1 file, ran 2 shell commands, listed 1 path`).
- Extension tools in a turn summary share one clause (`used vcc_recall, mcp ×2 and web_fetch`) instead of one `used 1 …` clause each.
- Collapsed skill blocks no longer lead with Pi's `References are relative to …` line, collapsed pi-vcc summaries skip their `[Session Goal]` heading, and underscores inside words (`snake_case`) are no longer stripped from the preview.
- A running user `!command` showed `Running · 0.0s`; it now shows its elapsed time.

### Changed

- Removed unused rendering helpers and options from the tool presentation code and enabled `noUnusedLocals`; no visible change.

## [1.0.15] - 2026-10-01

### Fixed

- Stopped automatically re-enabling `grep/find/ls`, preserving tools deliberately disabled by other extensions (including `pi-hashline-edit-pro`) regardless of package order with the default configuration (#4).
- Read-only tool activation now resolves configuration and project trust first and respects `enabled: false` and `PI_OMP_THEME_DISABLED=1`.

### Changed

- Read-only tool activation is opt-in through `piOmpTheme.readonlyTools: true`. The CLI override now requires `--pi-omp-theme-readonly-tools=true|false`; the former bare boolean flag is no longer supported. Explicit `false` works on Pi versions that coerce boolean CLI flags to `true`.
- Opt-out leaves the existing active tool set alone. Activation runs only at session boundaries, not during presentation/configuration updates.

### Added

- Regression tests and an isolated, packed-package CLI E2E suite covering package order, configuration/trust/disable gates, CLI values, tool selection constraints, session changes, reload, and an anchored search-to-edit workflow.

## [1.0.14] - 2026-09-29

### Fixed

- Framed `ask_user_question`'s own question/answer result inside the existing tool box instead of flattening it into generic machine output. This exception applies only to Ask results; todo and other tools retain their existing boxed presentation, expansion, and background handling.

### Added

- Regression coverage for boxed Ask result ownership, native component invalidation, narrow terminal widths, and unchanged Todo/Web Fetch expansion and background handling.

## [1.0.13] - 2026-09-26

### Changed

- The welcome card now prefers Pi's explicit session name, then a generated session title, then the opening user request. It scans up to 12 recent session files and reads up to 1 MiB from each to reach titles beyond large early entries.

### Fixed

- Clearing a session name no longer resurrects an older explicit or generated title; later generated titles can still appear.
- Generated titles with line breaks or control characters stay on one welcome-card row instead of breaking the frame.

### Added

- Regression and session-start integration coverage for title precedence, clearing, long session heads, sparse histories, and welcome-card rendering.

## [1.0.12] - 2026-09-12

### Fixed

- Kept completed `ask_user_question` cards and their selected answers visible instead of collapsing the user's decision record into a generic `used 1 ask_user_question` turn summary.

## [1.0.11] - 2026-09-12

### Fixed

- Standardized user-facing shortcut hints on title-cased, configured keybindings (`Ctrl+O to expand` by default) across special-message blocks, tool previews, diffs, and the working indicator. Remapped and unbound actions now update or hide their hints instead of leaving hard-coded shortcuts behind.

## [1.0.10] - 2026-09-12

### Fixed

- Restored Pi's native, model-aware thinking-level cycle by removing the theme's hard-coded `Shift+Tab` interception. Custom keybindings and model-specific level maps now remain authoritative, non-reasoning models retain Pi's native feedback, and status updates continue through `thinking_level_select`.

## [1.0.9] - 2026-09-05

### Changed

- `/pi-omp-theme doctor` now shows a compact, human-readable health report; use `/pi-omp-theme doctor json` for the complete diagnostic payload.
- Updated the development and release-verification baseline to Pi 0.85.0 while retaining runtime-identity compatibility with unchanged older surfaces.

### Fixed

- Recognized Pi 0.85.0's relocated built-in tool renderer identities so boxed tool calls and results do not fall back to the native renderer; hidden-thinking cleanup also handles Pi's new `MouseRegion` wrapper.
- Scoped compatibility state to each TUI surface and classified fallback causes explicitly, so an intentionally disabled assistant decoration no longer makes configured special blocks look incompatible.

## [1.0.8] - 2026-09-01

### Reverted

- Reverted the v1.0.7 transcript geometry rollout after visual regressions made boxed Bash and error output feel heavier and less polished than the established renderer.
- Restored the complete v1.0.6 rendering behavior, including native custom-tool ownership, the native working indicator, prior box spacing and narrow-width handling, and the Pi 0.84.2 development baseline.

## [1.0.7] - 2026-09-01

### Fixed

- Unified transcript geometry around a shared column contract: top-level frames and markers start at column 0, primary content starts at column 2, and nested content starts at column 4.
- Made compact-box rendering own both call and result presentation for custom tools, preventing native renderer padding from shifting tools such as Web Fetch to the right of Read, List, and Grep.
- Replaced Pi's inset working loader with an aligned public widget while preserving the native working-message fallback on hosts without widget ownership APIs.
- Restored boxed breathing rows that were accidentally omitted in every chrome mode, while light chrome continues to omit frame-only padding.
- Kept boxed rows within narrow terminal budgets instead of forcing the preferred 12-column width when only 11 columns are available.

### Changed

- Updated the development/runtime verification baseline to Pi 0.84.4 and added geometry, custom-renderer, working-row, and real `ToolExecutionComponent` regression coverage.

## [1.0.6] - 2026-08-26

### Fixed

- Kept boxed tool calls open when streamed result output follows a pending call, including calls already above the viewport. Lazy result state and topology-aware viewport caching now prevent stale closing borders and disconnected `Output` dividers.

## [1.0.5] - 2026-08-24

### Fixed

- Recognized Pi 0.84.3's minified bundled-runtime method identities through stable source markers, so message and tool compatibility patches install instead of falling back to Pi's default TUI rendering.

## [1.0.4] - 2026-08-24

### Fixed

- Fixed the host-binding diagnostic for Pi 0.84.3's bundled Node/RPC runtime. The extension loader's virtual host modules are now recognized as the running Pi instead of being mistaken for a second modular package copy; Pi version detection also prefers the actual host entrypoint over a local development peer.
- Removed the hardcoded Pi version allowlist from compatibility reporting. Patches now report live per-surface identity certification and continue to support future versions automatically when their native identities are unchanged.

## [1.0.3] - 2026-08-24

### Added

- Added `CFG-PRESET-OVERRIDE` diagnostics when explicit placement, editor, separator, or status-layout values contradict a coordinated preset and produce a hybrid UI.
- Added regression coverage for host binding, elapsed-ticker cleanup, viewport-aware turn collapse, preset resolution, and narrow-terminal status rendering; `npm test` now runs every compiled `*.test.ts` suite.

### Changed

- Reworked the README configuration example around a preset-first setup and documented when explicit fields intentionally override preset-owned composition.
- The host-binding probe and the global configuration read now start when the extension loads instead of inside `session_start`, and the welcome card reads only the head of each recent session file, so the themed editor, status line, and header replace Pi's native startup frame sooner. Project settings are still read only after `isProjectTrusted()` answers.
- Moved the renderer-viewport facts to `shared/viewport.ts` so surfaces outside the tool renderers can ask whether their rows are still reachable.

### Fixed

- Fixed a full-screen repaint after every `write`, `edit`, and `bash` result. The git refresh handed the welcome card a snapshot without `resources`, flipping its "Tool providers" panel to "No tool providers" at the top of the transcript; once that row had scrolled out of view, pi-tui could only paint the change by clearing the screen and scrollback and replaying the whole transcript (`fullRender: firstChanged < viewportTop (9 < …)`). Every update path now builds the same startup snapshot, and the header only invalidates when the data it paints (model, provider, resources) changes.
- Stopped tool call cards from rewriting rows that have scrolled above pi-tui's viewport. Live elapsed labels and the batch, grep, and semantic-bash panels are rebuilt on every `updateDisplay`, so an out-of-reach card kept forcing the clear-and-replay redraw for the rest of the run; such a card now keeps its painted lines. An explicit `Ctrl+O` expansion still repaints on request. Settlement repaints only for tools whose final output lives in the call card (`read`/`find`/`ls` batches, `grep`, `write`, and parsed semantic-bash cards); tools with a dedicated result component keep the painted call card and settle at the visible result tail. Result bodies are never frozen and keep streaming.
- The per-second elapsed ticker now stops itself once its block leaves the viewport instead of rebuilding a block nobody can see.
- The welcome card stops repainting itself once the transcript has scrolled past it, so a mid-session model switch no longer wipes the scrollback.
- Captured project trust once at session start and reused that decision for configuration loading and runtime state, preventing the two paths from diverging within one session.

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

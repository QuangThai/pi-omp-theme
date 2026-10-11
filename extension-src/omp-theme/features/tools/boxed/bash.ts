// Boxed bash tool renderer
// (renderCall/renderResult only).
//
// Inline chrome reuses the same parsing (terminal status, notices, semantic
// classes) and only swaps the presentation: `● Bash(command)` and a `⎿`
// gutter carrying the output tail and a dim status/elapsed row.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, type Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../shared/ansi.js";
import type { BoxTheme } from "../../../shared/box.js";
import {
	formatBoxedRunningStatus,
	formatBoxedWords,
	formatToolOutputLine,
	getTextOutput,
	isInlineChrome,
	renderBoxedToolCall,
	renderBoxedToolResult,
	replaceTabs,
	shortenPath,
} from "../../../shared/box.js";
import {
	inlineBlock,
	inlineContentWidth,
	inlineElapsed,
	inlineGutterComponent,
	inlineGutterLines,
	inlineHeaderLine,
	inlineMarker,
	inlineMeta,
	inlineMoreRow,
	inlineRunningRow,
	inlineStatus,
} from "../../../shared/inline.js";
import { toolExpandHint } from "../../../shared/keybinding-hints.js";
import { safeTruncateToWidth, safeVisibleWidth, truncateAtCodePointBoundary } from "../../../shared/render-budget.js";
import { parseSimpleBashCommand } from "./command-shape.js";
import {
	classifyGhCommand,
	type GhParsedSemantic,
	type GhRunJobParsed,
	type GhSemanticClass,
	parseGhOutput,
	renderGhCardLines,
	renderGhRunJobResult,
} from "./gh.js";
import {
	classifyGitCommand,
	type GitDiffParsed,
	type GitParsedSemantic,
	type GitSemanticClass,
	parseGitOutput,
	renderGitCardLines,
	renderGitDiffResult,
} from "./git.js";
import {
	GREP_COLLAPSED_LINE_LIMIT,
	type GrepDisplayLine,
	type GrepMatch,
	grepTreeShownLines,
	groupMatchesByFile,
	parseFindOutput,
	parseGrepBareDisplayOutput,
	parseGrepBareOutput,
	parseGrepDisplayOutput,
	parseGrepOutput,
	parseLsLongOutput,
	parseLsOutput,
	pluralForm,
	renderGrepTree,
	renderOutputTree,
	SEARCH_ICON,
	TREE_INDENT,
} from "./output-tree.js";
import {
	getStateElapsedMs,
	getToolsRenderConfig,
	isResultSeen,
	markResultSeen,
	recordExecutionEnded,
	startElapsedTicker,
	stopElapsedTicker,
} from "./session-config.js";
import { type BoxedToolContext, type BoxedToolDefinition, noteBoxedCallState, noteExecutionStart } from "./shared.js";

const MAX_LINE_CHARS = 2000;
const ESC = "\x1b";
const BASH_TOOL_NOTICE_PATTERN = /^\[Showing (?:last|lines)\b.*\. Full output: .+\]$/;
const BG_ANSI_PATTERN = new RegExp(`${ESC}\\[4[0-9;]*m`, "g");
const SHELL_VAR_PATTERN = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;
const SHELL_OP_PATTERN = /^(?:&&|\|\||>>|>&|\|&|[|&;()<>])$/;

function highlightBashFallback(line: string): string {
	try {
		const highlighted = highlightCode(line, "bash")[0] ?? line;
		// Strip background colors to avoid clashing with badge/parens styling
		return highlighted.replace(BG_ANSI_PATTERN, "");
	} catch {
		return line;
	}
}

function normalizeShellWord(word: string): string {
	return word.replace(/^(['"])(.*)\1$/, "$2");
}

function colorShellWord(theme: BoxTheme, word: string, commandExpected: boolean): string {
	const normalized = normalizeShellWord(word);
	if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(normalized)) return theme.fg("syntaxVariable", word);
	if (normalized.startsWith("-")) return theme.fg("syntaxKeyword", word);
	if (normalized.includes("/") || /^\.{1,2}(?:\/|$)/.test(normalized)) return theme.fg("syntaxVariable", word);
	if (SHELL_VAR_PATTERN.test(normalized)) return theme.fg("syntaxVariable", word);
	return commandExpected ? theme.fg("syntaxFunction", word) : theme.fg("syntaxString", word);
}

function tokenizeShellLinePreservingText(line: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;

	for (let i = 0; i < line.length; i++) {
		const char = line[i] ?? "";
		const next = line[i + 1] ?? "";

		if (quote) {
			current += char;
			if (char === "\\" && next) current += line[++i] ?? "";
			else if (char === quote) quote = null;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			tokens.push(char);
			continue;
		}

		if (char === "#" && !current) {
			if (current) tokens.push(current);
			tokens.push(line.slice(i));
			return tokens;
		}

		const two = `${char}${next}`;
		if (SHELL_OP_PATTERN.test(two) || SHELL_OP_PATTERN.test(char)) {
			if (current) tokens.push(current);
			current = "";
			if (SHELL_OP_PATTERN.test(two)) {
				tokens.push(two);
				i++;
			} else {
				tokens.push(char);
			}
			continue;
		}

		current += char;
	}

	if (quote) return undefined;
	if (current) tokens.push(current);
	return tokens;
}

function highlightBashLine(line: string, theme: BoxTheme): string {
	const tokens = tokenizeShellLinePreservingText(line);
	if (!tokens) return highlightBashFallback(line);
	let commandExpected = true;
	return tokens
		.map((token) => {
			if (/^\s+$/.test(token)) return token;
			if (token.startsWith("#")) return theme.fg("syntaxComment", token);
			if (SHELL_OP_PATTERN.test(token)) {
				commandExpected = token === "|" || token === "||" || token === "&&" || token === ";" || token === "&";
				return theme.fg("syntaxOperator", token);
			}
			const styled = colorShellWord(theme, token, commandExpected);
			if (!/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(normalizeShellWord(token))) commandExpected = false;
			return styled;
		})
		.join("");
}

function clampLineLength(line: string, max: number = MAX_LINE_CHARS): string {
	if (line.length <= max) return line;
	return `${truncateAtCodePointBoundary(line, max)}… (truncated)`;
}

function countNewlines(text: string, from: number, to: number): number {
	let count = 0;
	for (let i = from; i < to; i++) {
		if (text.charCodeAt(i) === 10) count++;
	}
	return count;
}

function stripBashToolNoticeLines(text: string): string {
	const filteredLines = text
		.replace(/\r/g, "")
		.split("\n")
		.filter((line) => !BASH_TOOL_NOTICE_PATTERN.test(line.trim()));
	return filteredLines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

function renderBoxedBashCall(theme: BoxTheme, commandLines: string[], context: BoxedToolContext): Component {
	if (isInlineChrome()) return renderInlineBashCall(theme, commandLines, context);
	const maxCommandLines = 5;
	const shownCount = Math.min(commandLines.length, maxCommandLines + 1);
	const detailLines: string[] = [];
	for (let i = 0; i < shownCount; i++) {
		const prefix = i === 0 ? theme.fg("dim", "$ ") : theme.fg("dim", "> ");
		detailLines.push(`${prefix}${highlightBashLine(commandLines[i] ?? "", theme)}`);
	}
	if (commandLines.length > maxCommandLines + 1) {
		detailLines.push(theme.fg("muted", `... ${commandLines.length - maxCommandLines - 1} more lines`));
	}
	const running = Boolean(context.executionStarted);
	const resultSeen = () => isResultSeen(context.state);
	const base = {
		isError: Boolean(context.isError),
		isPending: Boolean(context.isPartial),
		running,
	};
	if (running && context.isPartial && !resultSeen()) {
		// Pre-result running card: the call closes the box with a live running
		// footer and a `No output received yet` line. The first partial result
		// renders nothing, so this card is never duplicated below.
		detailLines.push(theme.fg("dim", "No output received yet"));
		return renderBoxedToolCall(theme, "Bash", detailLines, {
			...base,
			showHeader: false,
			pendingLabel: formatBoxedRunningStatus(theme, getStateElapsedMs(context.state)),
			resultSeen,
		});
	}
	// Streaming (a result renderer already continues this box) and terminal
	// (settled) passes leave the box open so the result closes it.
	return renderBoxedToolCall(theme, "Bash", detailLines, { ...base, showHeader: false, resultSeen });
}

// ── Terminal status detection ────────────────────────────────────────────────
// The bash tool appends a `\n\n<status>` suffix to failed results (nonzero exit,
// timeout, abort). Parse it off the raw text so the footer can carry the real
// status instead of displaying the suffix as output.

type BashTerminalStatus =
	| { kind: "exit"; exitCode: number }
	| { kind: "timeout"; seconds: number }
	| { kind: "cancelled" };

const BASH_STATUS_PATTERNS: ReadonlyArray<{
	re: RegExp;
	build: (match: RegExpMatchArray) => BashTerminalStatus;
}> = [
	{
		re: /(?:^|\n\n)Command timed out after ([\d.]+) seconds$/i,
		build: (match) => ({ kind: "timeout", seconds: Number(match[1]) }),
	},
	{ re: /(?:^|\n\n)[^\n]*aborted$/i, build: () => ({ kind: "cancelled" }) },
	{
		re: /(?:^|\n\n)Command exited with code (\d+)$/i,
		build: (match) => ({ kind: "exit", exitCode: Number(match[1]) }),
	},
];

function parseBashTerminalStatus(text: string): { status: BashTerminalStatus | undefined; body: string } {
	const clean = String(text ?? "").replace(/\r/g, "");
	for (const { re, build } of BASH_STATUS_PATTERNS) {
		const match = clean.match(re);
		if (match && match.index !== undefined) {
			return { status: build(match), body: clean.slice(0, match.index).trimEnd() };
		}
	}
	// Pi's message_end error path (agent aborted) sends a bare status text with
	// no bash output shape; recognize it as a cancelled state.
	if (/^(?:operation )?aborted(?: after \d+ retry attempts?)?$/i.test(clean.trim())) {
		return { status: { kind: "cancelled" }, body: "" };
	}
	return { status: undefined, body: clean };
}

function bashErrorLabel(status: BashTerminalStatus | undefined): string | undefined {
	if (status?.kind === "timeout") return "✘ Timed out";
	if (status?.kind === "cancelled") return "✘ Cancelled";
	return undefined;
}

/** Body text shown when a terminal bash result produced no output. */
function bashEmptyBodyText(status: BashTerminalStatus | undefined, isError: boolean): string {
	if (status?.kind === "timeout") return "No output was received before the timeout";
	if (status?.kind === "cancelled") return "Command was cancelled without producing output";
	if (isError) return "Command failed without producing output";
	return "Command completed without producing output";
}

function bashFooter(
	theme: BoxTheme,
	status: BashTerminalStatus | undefined,
	elapsedMs: number | undefined,
	bodyText: string,
	isError: boolean,
): string {
	const elapsed = elapsedMs === undefined ? "--" : `${(elapsedMs / 1000).toFixed(2)}s`;
	const words = bodyText.trim() ? formatBoxedWords(bodyText) : "";

	if (status?.kind === "timeout") {
		const seconds = Number.isFinite(status.seconds) && status.seconds > 0 ? status.seconds : Number.NaN;
		return theme.fg(
			"warning",
			Number.isFinite(seconds) ? `Terminated after ${seconds.toFixed(1)}s` : "Terminated by timeout",
		);
	}
	if (status?.kind === "cancelled") {
		return [theme.fg("warning", "Cancelled"), theme.fg("text", elapsed)].join(theme.fg("dim", " · "));
	}

	const exitLabel = status?.kind === "exit" ? `Exit ${status.exitCode}` : isError ? "Failed" : "Exit 0";
	const exitColor = status?.kind === "exit" && status.exitCode !== 0 ? "error" : "text";
	const parts = [theme.fg(exitColor, exitLabel), theme.fg("text", elapsed)];
	if (words) parts.push(theme.fg("dim", words));
	return parts.join(theme.fg("dim", " · "));
}

// ── Interactive command heuristics ───────────────────────────────────────────
// Terminal programs that read stdin or own the screen produce no pipe output;
// when one runs silently we hint that it may be waiting for terminal input.

const INTERACTIVE_COMMANDS = new Set([
	"pi",
	"vim",
	"vi",
	"nvim",
	"nano",
	"less",
	"more",
	"man",
	"top",
	"htop",
	"btop",
	"ssh",
	"telnet",
	"python",
	"python3",
	"node",
	"sqlite3",
	"mysql",
	"psql",
	"redis-cli",
	"mongosh",
	"bc",
	"irssi",
]);

function isInteractiveCommand(command: unknown): boolean {
	const base =
		(
			String(command ?? "")
				.trim()
				.split(/\s+/)[0] ?? ""
		)
			.split("/")
			.pop() ?? "";
	return INTERACTIVE_COMMANDS.has(base);
}

/** Wrap an output preview so an empty result renders state text instead of `∅`. */
function bashBodyComponent(preview: Component, emptyLines: string[] | undefined): Component {
	if (!emptyLines) return preview;
	return {
		invalidate: () => preview.invalidate(),
		render(width: number): string[] {
			const lines = preview.render(width);
			return lines.length > 0 ? lines : emptyLines;
		},
	};
}

/** Streaming continuation: streamed output (or `No output received yet`), a
 *  live running footer, and no `Response` divider until the tool settles. */
function renderBashStreamingResult(
	theme: BoxTheme,
	raw: string,
	options: { expanded: boolean },
	context: BoxedToolContext,
): Component {
	const body = stripBashToolNoticeLines(stripAnsi(raw));
	const hasOutput = body.trim().length > 0;
	const elapsed = getStateElapsedMs(context.state);
	const emptyLines: string[] = [theme.fg("dim", "No output received yet")];
	if (!hasOutput && isInteractiveCommand(context?.args?.command) && (elapsed ?? 0) >= 1000) {
		emptyLines.push(theme.fg("dim", "The process may be waiting for terminal input"));
	}
	const preview = createBashResultPreview(theme, body, options);
	if (isInlineChrome()) {
		// The first empty row says what the running row already says.
		return inlineBlock(theme, undefined, (contentWidth) => [
			...(hasOutput ? preview.render(contentWidth) : emptyLines.slice(1)),
			inlineRunningRow(theme, elapsed),
		]);
	}
	return renderBoxedToolResult(theme, bashBodyComponent(preview, hasOutput ? undefined : emptyLines), {
		dividerLabel: "Output",
		showDivider: hasOutput,
		footerLines: [formatBoxedRunningStatus(theme, elapsed)],
	});
}

function renderBashFinalResult(
	theme: BoxTheme,
	raw: string,
	options: { expanded: boolean },
	context: BoxedToolContext,
): Component {
	const isError = Boolean(context.isError);
	const clean = stripAnsi(raw);
	const parsed = parseBashTerminalStatus(clean);
	const status = parsed.status;
	// Pi reports an empty run as "(no output)"; that is a state, not output.
	const statusStripped = parsed.body.trim() === "(no output)" ? "" : parsed.body;
	const output = stripBashToolNoticeLines(statusStripped);
	const elapsed = getStateElapsedMs(context.state);
	const footer = bashFooter(theme, status, elapsed, output, isError);
	const errorLabel = isError ? (bashErrorLabel(status) ?? "✘ Error") : undefined;
	if (isInlineChrome()) return renderInlineBashFinalResult(theme, output, status, options, context);

	if (!options.expanded) {
		// Collapsed: only process the tail of the output (notices stripped per line).
		const scanLines = getToolsRenderConfig().maxCollapsedLines + 10;
		let nlCount = 0;
		let tailStart = 0;
		for (let i = statusStripped.length - 1; i >= 0; i--) {
			if (statusStripped.charCodeAt(i) === 10) {
				nlCount++;
				if (nlCount >= scanLines) {
					tailStart = i + 1;
					break;
				}
			}
		}
		const tail = stripBashToolNoticeLines(stripAnsi(statusStripped.slice(tailStart)));
		const totalLinesBefore = tailStart > 0 ? countNewlines(statusStripped, 0, tailStart) : 0;
		const preview = createBashResultPreview(theme, tail, options);
		const expandHint = totalLinesBefore > 0 ? toolExpandHint() : "";
		return renderBoxedToolResult(
			theme,
			bashBodyComponent(
				preview,
				statusStripped.trim() ? undefined : [theme.fg("muted", bashEmptyBodyText(status, isError))],
			),
			{
				footerLines: [footer],
				...(expandHint ? { expandHint } : {}),
				isError,
				...(errorLabel ? { errorLabel } : {}),
			},
		);
	}

	const preview = createBashResultPreview(theme, output, options);
	return renderBoxedToolResult(
		theme,
		bashBodyComponent(preview, output.trim() ? undefined : [theme.fg("muted", bashEmptyBodyText(status, isError))]),
		{
			footerLines: [footer],
			isError,
			...(errorLabel ? { errorLabel } : {}),
		},
	);
}

/** First-partial-pass result: the pending/running call card stands alone. */
const EMPTY_BASH_RESULT: Component = Object.freeze({
	invalidate() {},
	render() {
		return [];
	},
});

function createBashResultPreview(
	theme: BoxTheme,
	text: string,
	options: { expanded: boolean },
): Component {
	let cacheKey = "";
	let cacheLines: string[] | null = null;

	return {
		invalidate() {
			cacheKey = "";
			cacheLines = null;
		},
		render(width: number): string[] {
			const bodyWidth = Math.max(1, width);
			const cfg = getToolsRenderConfig();
			const expanded = Boolean(options.expanded);
			const cacheId = `${bodyWidth}|${expanded ? 1 : 0}|${cfg.maxExpandedLines}|${cfg.dimOutput ? 1 : 0}`;
			if (cacheLines && cacheKey === cacheId) return cacheLines;

			if (!expanded) {
				// Collapsed: only process the tail of the output
				const needed = cfg.maxCollapsedLines;
				let totalNewlines = 0;
				let scanFrom = 0; // default: take full text if fewer than needed newlines
				for (let i = text.length - 1; i >= 0; i--) {
					if (text.charCodeAt(i) === 10) {
						totalNewlines++;
						if (totalNewlines === needed) {
							scanFrom = i + 1;
							break;
						}
					}
				}

				if (text.length === 0) {
					cacheKey = cacheId;
					cacheLines = [];
					return cacheLines;
				}

				const tail = replaceTabs(text.slice(scanFrom)).replace(/\r/g, "");
				const shownLines = tail ? tail.split("\n").map((l) => clampLineLength(l)) : [];

				if (shownLines.length === 0) {
					cacheKey = cacheId;
					cacheLines = [];
					return cacheLines;
				}

				const truncatedShown = shownLines.map((line) => {
					const truncated = safeTruncateToWidth(line, bodyWidth, "…");
					// Failure is already stated by the ✘ marker above and the exit code in
					// the footer. Repainting the whole payload red buries the one line
					// that explains the failure in a wall of the same colour.
					return cfg.dimOutput
						? formatToolOutputLine(theme, truncated)
						: formatToolOutputLine(theme, truncated, "text");
				});

				cacheKey = cacheId;
				cacheLines = truncatedShown;
				return cacheLines;
			}

			// Expanded: process all lines
			const normalized = replaceTabs(text);
			const logicalLines = normalized.split("\n").map((l) => clampLineLength(l));
			const hasOutput = !(logicalLines.length === 1 && logicalLines[0] === "");

			if (!hasOutput) {
				cacheKey = cacheId;
				cacheLines = [];
				return cacheLines;
			}

			const truncatedLines = logicalLines.map((line) => safeTruncateToWidth(line, bodyWidth, "…"));
			const expandedLines = truncatedLines.length === 1 && truncatedLines[0] === "" ? [] : truncatedLines;
			const applyColor = (l: string) =>
				cfg.dimOutput ? formatToolOutputLine(theme, l) : formatToolOutputLine(theme, l, "text");
			if (cfg.maxExpandedLines > 0 && expandedLines.length > cfg.maxExpandedLines) {
				const truncated = expandedLines.slice(-cfg.maxExpandedLines).map(applyColor);
				const remaining = expandedLines.length - cfg.maxExpandedLines;
				truncated.unshift(theme.fg("dim", `… ${remaining} earlier lines`));
				cacheKey = cacheId;
				cacheLines = truncated;
				return cacheLines;
			}

			cacheKey = cacheId;
			cacheLines = expandedLines.map(applyColor);
			return cacheLines;
		},
	};
}

// ── Inline presentation ──────────────────────────────────────────────────────

/**
 * Inline chrome hangs a semantic result body under the result gutter. When the
 * call panel's card already opened the gutter, the body continues it.
 */
function hangInline(theme: BoxTheme, component: Component, options: { continues?: boolean } = {}): Component {
	return isInlineChrome() ? inlineGutterComponent(theme, component, options) : component;
}

/** First command line, marked when more lines follow. */
function inlineCommandArgs(commandLines: readonly string[]): string {
	const lines = commandLines.map((line) => line.trim()).filter(Boolean);
	const first = lines[0] ?? "";
	return lines.length > 1 ? `${first} …` : first;
}

function renderInlineBashCall(theme: BoxTheme, commandLines: string[], context: BoxedToolContext): Component {
	return inlineBlock(theme, { status: inlineStatus(context), name: "Bash", args: inlineCommandArgs(commandLines) }, () =>
		// Painted after Pi built the result renderer of the same pass, so a result
		// that took over the running row is already recorded.
		context.isPartial && context.executionStarted && !isResultSeen(context.state)
			? [inlineRunningRow(theme, getStateElapsedMs(context.state))]
			: [],
	);
}

function inlineBashStatus(theme: BoxTheme, status: BashTerminalStatus | undefined, isError: boolean): string | undefined {
	if (status?.kind === "timeout") {
		const seconds = Number.isFinite(status.seconds) && status.seconds > 0 ? ` after ${status.seconds}s` : "";
		return theme.fg("warning", `✘ Timed out${seconds}`);
	}
	if (status?.kind === "cancelled") return theme.fg("warning", "✘ Cancelled");
	if (status?.kind === "exit" && status.exitCode !== 0) return theme.fg("error", `✘ Exit ${status.exitCode}`);
	return isError ? theme.fg("error", "✘ Failed") : undefined;
}

function renderInlineBashFinalResult(
	theme: BoxTheme,
	output: string,
	status: BashTerminalStatus | undefined,
	options: { expanded: boolean },
	context: BoxedToolContext,
): Component {
	const isError = Boolean(context.isError);
	const expanded = Boolean(options.expanded);
	const config = getToolsRenderConfig();
	// The preview shows the tail; collapsed, the earlier lines are counted here
	// (expanded, the preview itself notes the lines beyond its budget).
	const totalLines = output ? countNewlines(output, 0, output.length) + 1 : 0;
	const omitted = expanded ? 0 : Math.max(0, totalLines - config.maxCollapsedLines);
	const preview = createBashResultPreview(theme, output, { expanded });
	const elapsed = status?.kind === "timeout" ? undefined : inlineElapsed(getStateElapsedMs(context.state));
	return inlineBlock(theme, undefined, (contentWidth) => {
		const rows: string[] = [];
		if (omitted > 0) rows.push(inlineMoreRow(theme, omitted, false, "earlier line"));
		const lines = preview.render(contentWidth);
		// The status row already says why there is nothing; stay short.
		rows.push(...(lines.length > 0 ? lines : [theme.fg("dim", "(no output)")]));
		rows.push(
			inlineMeta(theme, [
				inlineBashStatus(theme, status, isError),
				elapsed,
				output.trim() ? formatBoxedWords(output) : undefined,
			]),
		);
		return rows;
	});
}

// ── ls/find/grep/rg command detection ───────────────────────────────────────
// A bash command whose real command is ls/find/grep/rg (after env assignments,
// sudo/env/time prefixes, and path stripping), with no shell metacharacters
// (pipes, redirects, `;`, `&&`, command substitution, subshells, newlines), is
// rendered as the same boxless output tree as the corresponding native tool.
// Everything else keeps the boxed command/response shell.

type BashTreeKind = "ls" | "find" | "grep";

interface BashTreeClass {
	readonly kind: BashTreeKind;
	readonly pattern?: string;
	readonly pathLabel?: string;
	/** grep: exactly one path positional — single-file output (`line: content`)
	 *  is attributed to it. */
	readonly singlePath?: string;
}

const BASH_GREP_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg"]);

/** grep/rg flags that consume a separate value token (`--type ts`). */
const GREP_VALUE_FLAGS = new Set([
	"-e",
	"--regexp",
	"-g",
	"--glob",
	"--type",
	"-t",
	"--include",
	"--exclude",
	"-C",
	"-A",
	"-B",
	"--context",
	"--after-context",
	"--before-context",
	"-m",
	"--max-count",
	"-M",
	"--max-columns",
	"--ignore-file",
]);

/** find flags that consume a separate value token (`-type f`). */
const FIND_VALUE_FLAGS = new Set([
	"-type",
	"-mtime",
	"-atime",
	"-ctime",
	"-size",
	"-maxdepth",
	"-mindepth",
	"-perm",
	"-group",
	"-user",
	"-newer",
]);

function classifyByArgs(kind: BashTreeKind, args: string[]): BashTreeClass {
	const positionals: string[] = [];
	let pattern: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const token = args[i] ?? "";
		if (
			(kind === "grep" && (token === "-e" || token === "--regexp")) ||
			(kind === "find" && (token === "-name" || token === "-iname" || token === "-path" || token === "-ipath"))
		) {
			pattern = args[++i];
			continue;
		}
		if (kind === "grep" && GREP_VALUE_FLAGS.has(token)) {
			i++; // skip the flag and its value
			continue;
		}
		if (kind === "find" && FIND_VALUE_FLAGS.has(token)) {
			i++; // skip the flag and its value
			continue;
		}
		if (token.startsWith("-")) continue;
		positionals.push(token);
	}
	const rawPath = positionals[0] ?? ".";
	const pathLabel = rawPath === "." ? "current directory" : shortenPath(rawPath);
	if (kind === "ls") return { kind, pathLabel };
	if (kind === "find") return { kind, ...(pattern !== undefined ? { pattern } : {}), pathLabel };
	const grepPattern = pattern ?? positionals[0];
	const pathArgs = pattern !== undefined ? positionals : positionals.slice(1);
	const grepPath = pathArgs.join(" ");
	const grepPathLabel = !grepPath || grepPath === "." ? "current directory" : shortenPath(grepPath);
	return {
		kind,
		...(grepPattern !== undefined ? { pattern: grepPattern } : {}),
		pathLabel: grepPathLabel,
		...(pathArgs.length === 1 ? { singlePath: pathArgs[0] ?? "" } : {}),
	};
}

/** Classify a bash command for tree rendering, or null to keep the boxed shell. */
export function classifyBashCommand(command: string): BashTreeClass | null {
	const shape = parseSimpleBashCommand(command, { allowTrailingTruncationPipe: true });
	if (!shape) return null;
	const rest = shape.tokens;
	const base = (rest[0] ?? "").split("/").pop() ?? "";
	let kind: BashTreeKind | null = null;
	if (base === "ls") kind = "ls";
	else if (base === "find") kind = "find";
	else if (BASH_GREP_COMMANDS.has(base)) kind = "grep";
	if (!kind) return null;

	const cls = classifyByArgs(kind, rest.slice(1));
	if (shape.cdDir && cls.pathLabel === "current directory") {
		return {
			kind,
			...(cls.pattern !== undefined ? { pattern: cls.pattern } : {}),
			pathLabel: shortenPath(shape.cdDir),
			...(cls.singlePath !== undefined ? { singlePath: cls.singlePath } : {}),
		};
	}
	return cls;
}

function bashTreeHeader(theme: BoxTheme, cls: BashTreeClass, counts?: { files?: number; matches?: number }): string {
	const label = cls.kind === "find" ? "Find" : cls.kind === "ls" ? "List" : "Grep";
	const hasDetail = Boolean(cls.pattern) || Boolean(counts);
	// ls/find/grep headers carry the magnifying-glass icon in Nerd Font mode.
	// Inline chrome leads the row with its status marker instead.
	const icon =
		getToolsRenderConfig().nerdFonts && !isInlineChrome() ? `${theme.fg("toolTitle", SEARCH_ICON)} ` : "";
	const prefixText = hasDetail ? `${label}:` : label;
	const prefix = theme.fg("toolTitle", typeof theme?.bold === "function" ? theme.bold(prefixText) : prefixText);
	const patternPart = cls.pattern ? ` ${theme.fg("muted", cls.pattern.replace(/\r\n?|\n/g, " "))}` : "";
	let middle = "";
	if (counts) {
		if (cls.kind === "grep") {
			const matches = counts.matches ?? 0;
			const files = counts.files ?? 0;
			middle = theme.fg(
				"dim",
				` ${matches} ${pluralForm("match", matches)} · ${files} ${pluralForm("file", files)}`,
			);
		} else {
			const files = counts.files ?? 0;
			middle = theme.fg("dim", ` ${files} ${pluralForm("file", files)}`);
		}
	}
	const pathPart =
		cls.pathLabel && cls.pathLabel !== "current directory" ? theme.fg("dim", ` · in ${cls.pathLabel}`) : "";
	return `${icon}${prefix}${patternPart}${middle}${pathPart}`;
}

/** `ls -l` long-format lines (permissions block) can't be parsed into names
 *  reliably; fall back to the boxed shell for those. A leading `total N`
 *  summary line is skipped before the check. */
function isLongFormatLs(text: string): boolean {
	const first = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !/^total\s+\d+$/i.test(line));
	return Boolean(first) && /^[bcdlsp-][rwxtsST-]{9}[\s@]/.test(first as string);
}

/** Parsed bash tree output, or null to fall back to the boxed shell
 *  (long-format ls, unparseable grep). */
type ParsedBashTree = { entries: string[] } | { matches: GrepMatch[]; displayLines: GrepDisplayLine[] };

function parseBashTreeOutput(cls: BashTreeClass, output: string): ParsedBashTree | null {
	if (cls.kind === "ls") {
		// `ls -l`/`ls -la` long format is parsed into names (with `/` for dirs)
		// so bash listings render like the List tool tree.
		if (isLongFormatLs(output)) return { entries: parseLsLongOutput(output) };
		return { entries: parseLsOutput(output) };
	}
	if (cls.kind === "find") return { entries: parseFindOutput(output) };
	const matches = parseGrepOutput(output);
	const displayLines = parseGrepDisplayOutput(output);
	if (matches.length === 0 && output.trim().length > 0) {
		// Single-file `rg`/`grep` output is `line: content` with no filename:
		// attribute matches and context to the command's single path argument.
		if (cls.singlePath) {
			const bare = parseGrepBareOutput(output, cls.singlePath);
			if (bare.length > 0) {
				return { matches: bare, displayLines: parseGrepBareDisplayOutput(output, cls.singlePath) };
			}
		}
		return null;
	}
	return { matches, displayLines };
}

interface BashTreeState {
	readonly cls: BashSemanticClass;
	/** Raw command, so the call panel can render the boxed bash call on fallback. */
	readonly command: string;
	/** `parsed` once the result arrives; `fallback` when the boxed shell takes over. */
	parsed?: ParsedSemantic;
	fallback?: boolean;
}

/** Classified semantic command: a bash tree (ls/find/grep), a git card, or a
 *  gh card (pr/issue/run). */
export type BashSemanticClass = BashTreeClass | GitSemanticClass | GhSemanticClass;
type ParsedSemantic = ParsedBashTree | GitParsedSemantic | GhParsedSemantic;

/** Classify a bash command for semantic rendering (tree, git card, or gh
 *  card), or null to keep the boxed command/response shell. */
export function classifyBashSemantic(command: string): BashSemanticClass | null {
	return classifyBashCommand(command) ?? classifyGitCommand(command) ?? classifyGhCommand(command);
}

function isBashTreeClass(cls: BashSemanticClass): cls is BashTreeClass {
	return cls.kind === "ls" || cls.kind === "find" || cls.kind === "grep";
}

/** Type guard for the gh semantic classes (pr/issue/run list/view/checks/
 *  create/job). */
function isGhClass(cls: BashSemanticClass): cls is GhSemanticClass {
	switch (cls.kind) {
		case "pr-list":
		case "pr-view":
		case "pr-checks":
		case "pr-create":
		case "issue-list":
		case "issue-view":
		case "run-list":
		case "run-view":
		case "run-job":
			return true;
		default:
			return false;
	}
}

/** `gh run view --job=<id>` renders a boxed log result (Phase 8D); the other gh
 *  classes render their whole panel in the call card. */
function isGhRunJobClass(cls: BashSemanticClass): boolean {
	return cls.kind === "run-job";
}

/** `git diff` / `git show` render a boxed adaptive-diff result (Phase 8B); the
 *  other semantic classes render their whole panel in the call card. */
function isGitDiffClass(cls: BashSemanticClass): boolean {
	return !isBashTreeClass(cls) && (cls as GitSemanticClass).kind === "diff";
}

/** `git commit`/`push`/`pull`/`fetch` may produce informational exit-1 output
 *  (e.g. `git commit` with nothing staged) that still parses to a card. Their
 *  parsers are fail-closed, so genuine errors (push rejected, hook failure)
 *  return null and fall back to the raw boxed shell (ADR 0005). */
function isGitActionClass(cls: BashSemanticClass): boolean {
	return !isBashTreeClass(cls) && (cls as GitSemanticClass).kind === "action";
}

function parseSemanticOutput(cls: BashSemanticClass, output: string): ParsedSemantic | null {
	if (isBashTreeClass(cls)) return parseBashTreeOutput(cls, output);
	if (isGhClass(cls)) return parseGhOutput(cls, output);
	return parseGitOutput(cls, output);
}

const semanticStates = new Map<string, BashTreeState>();

/**
 * Whether the settled semantic result is painted by the call component.
 *
 * Most bash results render in the result component and must not force an
 * off-screen call card to repaint just to change its running chrome. Parsed
 * tree/card results are the exception: their result component is empty and the
 * semantic call panel owns the final output. Git diffs and GH job logs still
 * render in dedicated result components.
 */
export function bashSettledResultLivesInCall(toolCallId: string): boolean {
	const state = semanticStates.get(toolCallId);
	if (!state?.parsed || state.fallback) return false;
	return !isGitDiffClass(state.cls) && !isGhRunJobClass(state.cls);
}

/** Reset all semantic bash state (session start/shutdown, new message). */
export function resetBashTreeRegistry(): void {
	semanticStates.clear();
}

function linkBashGrepLine(
	context: BoxedToolContext,
	styledText: string,
	file: string,
	line?: number,
): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const url = pathToFileURL(resolve(context.cwd, file));
	if (line !== undefined) url.searchParams.set("line", String(line));
	return hyperlink(styledText, url.href);
}

/** Grep preview rows: omp's strict collapsed cap, then `maxExpandedLines` once expanded. */
function bashGrepLineBudget(expanded: boolean): number {
	const config = getToolsRenderConfig();
	const budget = expanded ? config.maxExpandedLines : Math.min(config.maxCollapsedLines, GREP_COLLAPSED_LINE_LIMIT);
	return Math.max(0, budget);
}

function renderBashTreeLines(
	theme: BoxTheme,
	state: { cls: BashTreeClass; parsed?: ParsedBashTree },
	width: number,
	expanded: boolean,
	context: BoxedToolContext,
): string[] {
	const safeWidth = Math.max(1, width);
	const cls = state.cls;
	if (state.parsed && "entries" in state.parsed) {
		const entries = state.parsed.entries;
		return renderOutputTree(theme, bashTreeHeader(theme, cls, { files: entries.length }), entries, safeWidth, {
			moreUnit: "file",
			indent: TREE_INDENT,
			withIcons: getToolsRenderConfig().nerdFonts,
		});
	}
	if (state.parsed && "matches" in state.parsed) {
		const matches = state.parsed.matches;
		const config = getToolsRenderConfig();
		return renderGrepTree(
			theme,
			bashTreeHeader(theme, cls, { matches: matches.length, files: groupMatchesByFile(matches).length }),
			matches,
			safeWidth,
			{
				indent: TREE_INDENT,
				withIcons: config.nerdFonts,
				lineBudget: bashGrepLineBudget(expanded),
				expanded,
				...(expanded ? {} : { expandHint: toolExpandHint() }),
				displayLines: state.parsed.displayLines,
				link: (styledText, file, line) => linkBashGrepLine(context, styledText, file, line),
			},
		);
	}
	return [safeTruncateToWidth(bashTreeHeader(theme, cls), safeWidth, "…")];
}

/** Empty result component — the tree lives in the call panel, which re-renders
 *  with the parsed output once the result arrives. */
const EMPTY_BASH_TREE_RESULT: Component = {
	invalidate() {},
	render() {
		return [];
	},
};

/** Live panel component for a classified bash command: pending header until the
 *  result arrives, then the parsed output tree/card. When the result falls back
 *  to the boxed shell, the call renders the boxed bash call instead, so call and
 *  result form one complete box and never duplicate. The state reference is
 *  captured at creation so a registry clear on session reset/resume does not
 *  blank already-rendered panels. */
function renderSemanticPanel(theme: BoxTheme, toolCallId: string, context: BoxedToolContext): Component {
	const panel = renderSemanticPanelBody(theme, toolCallId, context);
	if (!isInlineChrome()) return panel;
	const state = semanticStates.get(toolCallId);
	return {
		invalidate() {
			panel.invalidate();
		},
		render(width: number): string[] {
			// The unparsed fallback already renders an inline Bash block.
			if (!state || state.fallback) return panel.render(width);
			if (isBashTreeClass(state.cls)) {
				return renderInlineBashTreeLines(theme, state.cls, state.parsed as ParsedBashTree | undefined, width, context);
			}
			return renderInlineCardLines(theme, panel, width, context);
		},
	};
}

// ── Inline semantic panels ───────────────────────────────────────────────────
// ls/find/grep read like the inline List/Find/Grep tools: `● Grep(row in src)`,
// the count opening the gutter, the tree under it. Git and gh cards keep their
// title on the marker row and hang the rest of the card under the gutter.

/** Leading tree indent of a card row, also when the row's style opens first. */
const CARD_INDENT = new RegExp(`^((?:\\x1b\\[[0-9;]*m)*)${TREE_INDENT}`);

function dropCardIndent(line: string): string {
	return line.replace(CARD_INDENT, "$1");
}

function inlineTreeCall(cls: BashTreeClass): { name: string; args: string } {
	const path = cls.pathLabel && cls.pathLabel !== "current directory" ? cls.pathLabel : "";
	const pattern = cls.pattern?.replace(/\r\n?|\n/g, " ") ?? "";
	if (cls.kind === "ls") return { name: "List", args: path || "." };
	const args = pattern && path ? `${pattern} in ${path}` : pattern || path || ".";
	return { name: cls.kind === "find" ? "Find" : "Grep", args };
}

function renderInlineBashTreeLines(
	theme: BoxTheme,
	cls: BashTreeClass,
	parsed: ParsedBashTree | undefined,
	width: number,
	context: BoxedToolContext,
): string[] {
	const call = inlineTreeCall(cls);
	const header = inlineHeaderLine(theme, inlineStatus(context), call.name, call.args, width);
	if (!parsed) return [header];
	const config = getToolsRenderConfig();
	// The tree indents itself by TREE_INDENT; under the gutter that column is
	// already taken, so it is painted wider and the indent dropped.
	const treeWidth = inlineContentWidth(width) + TREE_INDENT.length;
	if ("entries" in parsed) {
		const count = parsed.entries.length;
		const summary =
			cls.kind === "find" ? `Found ${count} ${pluralForm("file", count)}` : `Listed ${count} ${pluralForm("path", count)}`;
		const tree = renderOutputTree(theme, "", parsed.entries, treeWidth, {
			moreUnit: "file",
			indent: TREE_INDENT,
			withIcons: config.nerdFonts,
		})
			.slice(1)
			.map(dropCardIndent);
		return [header, ...inlineGutterLines(theme, [theme.fg("dim", summary), ...tree], width)];
	}
	const matches = parsed.matches;
	if (matches.length === 0) return [header, ...inlineGutterLines(theme, [theme.fg("dim", "No matches")], width)];
	const expanded = context.expanded;
	const displayLines = parsed.displayLines ? { displayLines: parsed.displayLines } : {};
	const shown = (mode: boolean) =>
		grepTreeShownLines(matches, { lineBudget: bashGrepLineBudget(mode), expanded: mode, ...displayLines });
	// Ctrl+O only when the expanded tree paints lines this one leaves out.
	const hint = !expanded && shown(true) > shown(false) ? toolExpandHint() : "";
	const fileCount = groupMatchesByFile(matches).length;
	const counts = `${matches.length} ${pluralForm("match", matches.length)} in ${fileCount} ${pluralForm("file", fileCount)}`;
	const summary = theme.fg("dim", hint ? `${counts} · ${hint}` : counts);
	const tree = renderGrepTree(theme, "", matches, treeWidth, {
		indent: TREE_INDENT,
		withIcons: config.nerdFonts,
		lineBudget: bashGrepLineBudget(expanded),
		expanded,
		...displayLines,
		link: (styledText, file, line) => linkBashGrepLine(context, styledText, file, line),
	})
		.slice(1)
		.map(dropCardIndent);
	return [header, ...inlineGutterLines(theme, [summary, ...tree], width)];
}

/** A git/gh card inline: its title on the marker row, the rest under the gutter. */
function renderInlineCardLines(theme: BoxTheme, panel: Component, width: number, context: BoxedToolContext): string[] {
	const marker = `${inlineMarker(theme, inlineStatus(context))} `;
	const [title = ""] = panel.render(Math.max(1, width - safeVisibleWidth(marker)));
	if (!title) return [];
	const [, ...rest] = panel.render(inlineContentWidth(width) + TREE_INDENT.length);
	return [`${marker}${title}`, ...inlineGutterLines(theme, rest.map(dropCardIndent), width)];
}

/** True when the inline card already opened the result gutter with rows of its own. */
function semanticCardHasBody(theme: BoxTheme, toolCallId: string, context: BoxedToolContext): boolean {
	return renderSemanticPanelBody(theme, toolCallId, context).render(80).length > 1;
}

function renderSemanticPanelBody(theme: BoxTheme, toolCallId: string, context: BoxedToolContext): Component {
	const state = semanticStates.get(toolCallId);
	return {
		invalidate() {},
		render(width: number): string[] {
			if (!state) return [];
			if (state.fallback) return renderBoxedBashCall(theme, state.command.split("\n"), context).render(width);
			if (isBashTreeClass(state.cls)) {
				const treeState: { cls: BashTreeClass; parsed?: ParsedBashTree } = { cls: state.cls };
				if (state.parsed !== undefined) treeState.parsed = state.parsed as ParsedBashTree;
				return renderBashTreeLines(theme, treeState, width, context.expanded, context);
			}
			// Git classes only ever carry git parsed values (parseSemanticOutput
			// dispatches on the class), so the narrowed cast is exact.
			if (isGhClass(state.cls)) {
				const ghState: { cls: GhSemanticClass; parsed?: GhParsedSemantic } = { cls: state.cls };
				if (state.parsed !== undefined) ghState.parsed = state.parsed as GhParsedSemantic;
				return renderGhCardLines(theme, ghState, width);
			}
			const gitState: { cls: GitSemanticClass; parsed?: GitParsedSemantic } = { cls: state.cls };
			if (state.parsed !== undefined) gitState.parsed = state.parsed as GitParsedSemantic;
			return renderGitCardLines(theme, gitState, width);
		},
	};
}

export const bashTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const cls = classifyBashSemantic(String(args?.command ?? ""));
		if (cls) {
			semanticStates.set(context.toolCallId, { cls, command: String(args?.command ?? "") });
			return renderSemanticPanel(theme, context.toolCallId, context);
		}
		noteBoxedCallState(context);
		const rawCommand = String(args?.command ?? "...");
		return renderBoxedBashCall(theme, rawCommand.split("\n"), context);
	},
	result(result, options, theme, context) {
		const firstResultPass = !isResultSeen(context.state);
		markResultSeen(context.state);
		const cls = classifyBashSemantic(String(context?.args?.command ?? ""));
		// Action classes (commit/push/pull/fetch) also attempt parsing on exit-1
		// results so informational states like `git commit` with nothing staged
		// render as a card; the fail-closed parser keeps genuine errors raw.
		if (cls && (!context.isError || isGitActionClass(cls))) {
			// Semantic-classified commands render in the call panel; the result adds
			// nothing. Keep terminal state in sync without an elapsed ticker. Git
			// parsers only run on the terminal result: streaming partial output may
			// hold a truncated line that would fail parsing and wrongly fall back.
			if (!options.isPartial) {
				recordExecutionEnded(context.state);
				stopElapsedTicker(context.state);
			}
			if (!options.isPartial || isBashTreeClass(cls)) {
				const output = stripBashToolNoticeLines(stripAnsi(getTextOutput(result)));
				const parsed = parseSemanticOutput(cls, output);
				const state = semanticStates.get(context.toolCallId);
				if (parsed) {
					if (state) state.parsed = parsed;
					else
						semanticStates.set(context.toolCallId, {
							cls,
							command: String(context?.args?.command ?? ""),
							parsed,
						});
					// `git diff` / `git show` render a boxed adaptive-diff result (one frame
					// per file); `gh run view --job=<id>` renders a boxed log result. Every
					// other semantic class renders its whole panel in the call card, so the
					// result adds nothing.
					const continues = isInlineChrome() && semanticCardHasBody(theme, context.toolCallId, context);
					if (isGitDiffClass(cls)) {
						// Inline, the card already reads `no changes`; only the elapsed row is left.
						if (continues && (parsed as GitDiffParsed).files.length === 0) {
							const elapsed = inlineElapsed(getStateElapsedMs(context.state));
							return inlineBlock(theme, undefined, () => (elapsed ? [inlineMeta(theme, [elapsed])] : []), {
								continues,
							});
						}
						const diff = renderGitDiffResult(theme, parsed as GitDiffParsed, options, context);
						return hangInline(theme, diff, { continues });
					}
					if (isGhRunJobClass(cls)) {
						const log = renderGhRunJobResult(theme, parsed as GhRunJobParsed, options, context);
						return hangInline(theme, log, { continues });
					}
					return EMPTY_BASH_TREE_RESULT;
				}
				// Unparseable output (ls -l, raw rg summary, non-git output): the boxed
				// shell owns the result; flag the call panel to render nothing so the
				// two don't duplicate.
				if (state) state.fallback = true;
			}
		} else if (options.isPartial) {
			startElapsedTicker(context.state, context.invalidate, context.toolCallId);
		} else {
			recordExecutionEnded(context.state);
			stopElapsedTicker(context.state);
		}
		const raw = getTextOutput(result);
		if (options.isPartial) {
			// First partial pass: the running call card stands alone. Later passes
			// stream output into the open continuation without a Response divider.
			// Inline chrome has no open frame to keep: its call drops the running row
			// once a result renderer exists, so the first pass carries it instead.
			if (firstResultPass && !isInlineChrome()) return EMPTY_BASH_RESULT;
			return renderBashStreamingResult(theme, raw, options, context);
		}
		return renderBashFinalResult(theme, raw, options, context);
	},
};

// Boxed tool-call/result rendering primitives.
//
// Two deliberate design points:
//
// 1. Background painting is removed. Boxed lines are foreground-only. For tool
//    blocks the decoration owner (features/tools/index.ts) also clears the
//    native ToolExecutionComponent status background and padding, so the frame
//    drawn here is the block's only boundary; the message-block Box applies
//    customMessageBg. This avoids double-background conflicts and keeps
//    pi-omp-theme's patches renderer-scoped.
//
// 2. Theme functions are accessed through a minimal structural interface
//    (BoxTheme) instead of `any`.

import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { fgHex, isHexColor, stripAnsi } from "./ansi.js";
import { getElapsedMs, type MetricResultLike } from "./elapsed.js";
import {
	boxedResultRenderBudget,
	clampRenderLine,
	DEFAULT_COLLAPSED_RENDER_LINES,
	fastBoxLineContent,
	safeTruncateToWidth,
	safeVisibleWidth,
	safeWrapTextWithAnsi,
} from "./render-budget.js";
import { getThemeExtra } from "./theme-extras.js";

/** Minimal structural view of Pi's Theme as used by the boxed renderers. */
export interface BoxTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	italic?(text: string): string;
	inverse?(text: string): string;
	getColorMode?(): string;
}

export interface BoxedRenderOptions {
	/** Draw a plain top border: the first content line already names the call. */
	showHeader?: boolean;
	/** Detail embedded in the top-border title after the tool name (e.g. the path). */
	headerDetail?: string;
	isError?: boolean;
	isPending?: boolean;
	/** Execution has started but the tool is still running (title `⟳`, running status). */
	running?: boolean;
	/** A result renderer already produced a continuation for this call, so the call
	 *  leaves the box open instead of closing it with a pending label. May be lazy
	 *  because Pi builds the call and result components before painting either. */
	resultSeen?: boolean | (() => boolean);
	pendingText?: string;
	/** Verbatim bottom-border label for the pending/running card (overrides the
	 *  `… ${pendingText}` default, e.g. a live `◌ Running · 12.4s` status). */
	pendingLabel?: string;
	state?: Record<string, unknown>;
	/** Wall-clock elapsed override (used when metrics are not in result.details). */
	elapsedMs?: number;
	/** Width-dependent content lines rendered between the top border and the
	 *  footer border of a compact box (replaces the blank breathing line).
	 *  Each returned line is truncated to the box inner width by the renderer.
	 *  Returns an empty array for no body (blank line preserved). */
	bodyLines?: (contentWidth: number) => string[];
	/** Right-side label embedded in the compact box bottom border before the
	 *  corner (for example, the configured expansion hint). */
	bottomRightLabel?: string;
}

export function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

export function resolveAbsolutePath(rawPath: string, cwd: string): string {
	const path = rawPath.trim();
	if (!path) return "";

	const home = process.env.HOME;
	if (home && (path === "~" || path.startsWith("~/"))) {
		return path === "~" ? home : resolve(home, path.slice(2));
	}

	return resolve(cwd, path);
}

export function resolveRelativePath(rawPath: string, cwd: string): string {
	const absPath = resolveAbsolutePath(rawPath, cwd);
	if (!absPath) return "(unknown)";
	const relPath = relative(cwd, absPath).replace(/\\/g, "/");
	return relPath || ".";
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function getTextOutput(result: MetricResultLike | undefined): string {
	if (!result?.content) return "";
	const textBlocks = result.content.filter((contentBlock) => {
		if (!contentBlock || typeof contentBlock !== "object") return false;
		return (contentBlock as { type?: unknown }).type === "text";
	});
	return textBlocks
		.map((contentBlock) => String((contentBlock as { text?: unknown }).text ?? ""))
		.join("\n")
		.replace(/\r/g, "");
}

export function countWords(text: string): number {
	let count = 0;
	let inWord = false;
	for (const char of text) {
		const isWord = /[\p{L}\p{N}_'-]/u.test(char);
		if (isWord && !inWord) count++;
		inWord = isWord;
	}
	return count;
}

export function formatCompactCount(value: number): string {
	if (value < 1000) return `${Math.round(value)}`;
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
	return `${Math.round(value / 1000000)}M`;
}

export function formatBoxedWords(text: string): string {
	const words = countWords(text);
	return `~${formatCompactCount(words)} ${words === 1 ? "word" : "words"}`;
}

export function parens(theme: BoxTheme, text: string, skipTextColor?: boolean): string {
	const bracketColor = getThemeExtra(theme, "parensBracketColor");
	const openParen = bracketColor && isHexColor(bracketColor) ? fgHex(theme, bracketColor, "(") : "(";
	const closeParen = bracketColor && isHexColor(bracketColor) ? fgHex(theme, bracketColor, ")") : ")";
	let innerBase: string;
	if (skipTextColor) {
		innerBase = text;
	} else {
		const textColor = getThemeExtra(theme, "parensTextColor");
		innerBase = textColor && isHexColor(textColor) ? fgHex(theme, textColor, text) : text;
	}
	const inner = typeof theme?.bold === "function" ? theme.bold(innerBase) : `\x1b[1m${innerBase}\x1b[22m`;
	return `${openParen}${inner}${closeParen}`;
}

const BOX_HORIZONTAL = "─";
const BOX_VERTICAL = "│";
const BOX_SIDE_PADDING = 1;
const BOX_MIN_WIDTH = 12;
const BOX_ROUND_TOP_LEFT = "╭";
const BOX_ROUND_TOP_RIGHT = "╮";
const BOX_ROUND_BOTTOM_LEFT = "╰";
const BOX_ROUND_BOTTOM_RIGHT = "╯";
const BOX_DIVIDER_LEFT = "├";
const BOX_DIVIDER_RIGHT = "┤";
/** Dash run before the right corner when a right-side border label is present. */
const BOX_LABELED_RIGHT_DASH_MIN = 3;
/** Dashes drawn between a corner/junction and an embedded label. */
const BOX_LABEL_CAP = BOX_HORIZONTAL.repeat(3);

export function boxWidth(width: number): number {
	return Math.max(BOX_MIN_WIDTH, width);
}

export function boxInnerWidth(width: number): number {
	return Math.max(1, boxWidth(width) - 2 - BOX_SIDE_PADDING * 2);
}

function titleCaseToolWord(value: string): string {
	const spaced = value
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.trim();
	return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatToolName(toolName: string): string {
	// MCP tools arrive as `mcp__<server>__<tool>`; spelling that out verbatim
	// gives titles like "Mcp Exa Web Search Exa". The server is the identity
	// worth leading with, so it becomes the title and the tool its subject.
	if (toolName.startsWith("mcp__")) {
		const rest = toolName.slice(5);
		const split = rest.includes("__") ? rest.indexOf("__") : rest.indexOf("_");
		if (split > 0) {
			const server = titleCaseToolWord(rest.slice(0, split));
			const tool = titleCaseToolWord(rest.slice(split).replace(/^_+/, ""));
			if (server && tool) return `${server}: ${tool}`;
		}
	}
	return titleCaseToolWord(toolName) || toolName;
}

function formatToolParamName(name: string): string {
	const spaced = name
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.trim();
	return spaced ? spaced[0]?.toUpperCase() + spaced.slice(1) : name;
}

const MAX_PARAM_VALUE_LENGTH = 120;

function formatOperationSummary(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	if (!value.every((item) => item && typeof item === "object" && !Array.isArray(item))) return undefined;
	// Only an array whose items declare a `type` reads as a list of operations.
	// A todo list carries `content`/`status` instead, and defaulting its missing
	// types to the literal word printed `3 operations (operation)`.
	const types = Array.from(
		new Set(value.map((item) => (item as { type?: unknown }).type).filter((type) => typeof type === "string")),
	);
	if (types.length === 0) return undefined;
	const typeSummary =
		types.length === 1 ? ` (${types[0]})` : ` (${types.slice(0, 3).join(", ")}${types.length > 3 ? ", …" : ""})`;
	return `${value.length} ${value.length === 1 ? "operation" : "operations"}${typeSummary}`;
}

function formatToolParamValue(value: unknown): string {
	if (value === undefined) return "";
	if (value === null) return "null";
	if (typeof value === "string") {
		if (value.length <= MAX_PARAM_VALUE_LENGTH) return value;
		return `${value.slice(0, MAX_PARAM_VALUE_LENGTH)}…`;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return formatOperationSummary(value) ?? `${value.length} ${value.length === 1 ? "item" : "items"}`;
	}
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		return `{${keys.length} ${keys.length === 1 ? "key" : "keys"}}`;
	}
	try {
		const json = JSON.stringify(value);
		if (json.length <= MAX_PARAM_VALUE_LENGTH) return json;
		return `${json.slice(0, MAX_PARAM_VALUE_LENGTH)}…`;
	} catch {
		return String(value);
	}
}

export function formatToolParamLines(args: unknown, theme?: BoxTheme): string[] {
	if (args === undefined || args === null) return [];
	if (typeof args !== "object" || Array.isArray(args)) {
		const value = formatToolParamValue(args);
		return value ? [`Params: ${value}`] : [];
	}

	const entries = Object.entries(args as Record<string, unknown>).filter(([, value]) => value !== undefined);
	if (entries.length === 0) return [];

	const lines: string[] = [];
	for (const [key, value] of entries) {
		const formattedValue = formatToolParamValue(value);
		if (!formattedValue) continue;
		const [firstLine = "", ...restLines] = formattedValue.replace(/\r/g, "").split("\n");
		const keyLabel = formatToolParamName(key);
		if (theme) {
			lines.push(`${theme.fg("dim", `${keyLabel}:`)} ${theme.fg("text", firstLine)}`);
			lines.push(...restLines.map((line) => `  ${theme.fg("text", line)}`));
		} else {
			lines.push(`${keyLabel}: ${firstLine}`);
			lines.push(...restLines.map((line) => `  ${line}`));
		}
	}
	return lines;
}

function colorFromExtra(theme: BoxTheme, extraKey: string, fallbackColor: string, text: string): string {
	const color = getThemeExtra(theme, extraKey);
	if (color) {
		if (isHexColor(color)) return fgHex(theme, color, text);
		try {
			return theme.fg(color, text);
		} catch {
			// Fall back to semantic theme color below.
		}
	}
	return theme.fg(fallbackColor, text);
}

/** Glyphs follow omp's unicode preset (modes/theme/symbols.ts, `tool.*`). */
const TOOL_GLYPHS: Readonly<Record<string, string>> = {
	bash: "❯",
	read: "▤",
	write: "✎",
	edit: "✎",
	quick: "✎",
	substitute: "✎",
	target: "✎",
	grep: "⌕",
	find: "⌕",
	search: "⌕",
	glob: "⌕",
	web: "⌕",
	ls: "▤",
	list: "▤",
	git: "⎇",
	gh: "⎇",
	// U+2611 ☑ reads as "already done", which is wrong for a call that writes or
	// updates a list, and it lives in a block terminals often paint two cells
	// wide while pi-tui measures one — the icon then crowds the title beside it.
	// U+274F is a plain checklist box from Dingbats, which is one cell everywhere.
	todo: "❏",
	task: "⇶",
	agent: "⇶",
	memory: "🧠",
	// pi-tui measures U+1F5D1 🗑 as one cell, but terminals commonly paint it two:
	// a row carrying it then overflows the frame it was measured against.
	delete: "⌫",
	move: "➜",
	fetch: "🌐",
	browser: "🌐",
	lsp: "💡",
	eval: "▶",
	debug: "🐞",
	mcp: "🔌",
	ask: "?",
	review: "◉",
	goal: "◎",
	ssh: "⇄",
};

/**
 * Identity glyph for a tool. Names reach here compounded (`todo_write`) and
 * already prettified (`Playwright: Browser Click`), so an unmapped name is
 * scanned word by word — the first word that names a known kind of work wins,
 * which reads better than a generic arrow on every extension tool.
 */
function toolGlyph(name: string): string {
	const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
	const exact = TOOL_GLYPHS[key];
	if (exact) return exact;
	for (const word of key.split("_")) {
		const glyph = word ? TOOL_GLYPHS[word] : undefined;
		if (glyph) return glyph;
	}
	return "➔";
}

/**
 * Colored `<glyph> Name` prefix for tool titles (identity color). The status
 * glyph (⟳/✘) is appended separately by formatBoxedToolTitle; success adds none.
 */
export function formatToolTitlePrefix(theme: BoxTheme, name: string): string {
	return colorFromExtra(theme, "bashPromptColor", "bashMode", `${toolGlyph(name)} ${name}`);
}

export type BoxedTitleStatus = "running" | "pending";

/**
 * Boxed tool title: `➔ Name` once settled, `➔ Name ⟳` while running, and a
 * fully error-colored `➔ Name ✘` on failure. Success carries no mark — the
 * quiet frame already says the call went fine, and a tick on every header just
 * adds noise to a transcript where most calls succeed.
 */
export function formatBoxedToolTitle(
	theme: BoxTheme,
	name: string,
	isError?: boolean,
	status?: BoxedTitleStatus,
): string {
	// On failure the whole title turns error-colored (not just the ✘) so a failed
	// tool reads instantly; a settled call keeps its identity color and no mark.
	const coloredTitle = isError
		? theme.fg("error", `${toolGlyph(name)} ${name} ✘`)
		: status === "running"
			? `${formatToolTitlePrefix(theme, name)} ${theme.fg("text", "⟳")}`
			: formatToolTitlePrefix(theme, name);
	return typeof theme?.bold === "function" ? theme.bold(coloredTitle) : coloredTitle;
}

/** Live running status label for pending/running cards and streaming footers. */
export function formatBoxedRunningStatus(theme: BoxTheme, elapsedMs: number | undefined): string {
	const elapsed = elapsedMs === undefined ? "" : `${theme.fg("text", ` · ${(elapsedMs / 1000).toFixed(1)}s`)}`;
	return `${theme.fg("dim", "◌ Running")}${elapsed}`;
}

/** Structural line — box frame, tree branch, divider, gutter — wrapped in
 * dim terminal-default intensity. Visible in every theme; matches omp. */
let boxDimTheme: BoxTheme | undefined;

/**
 * Register the session theme so tree connectors can take the theme's `dim`
 * colour, the way omp paints them (`tui/tree-list.ts`). Set by the session
 * coordinator alongside the other render-scoped theme registrations.
 */
export function setBoxTheme(theme: BoxTheme | undefined): void {
	boxDimTheme = theme;
}

/**
 * De-emphasised tree chrome. SGR faint alone is terminal-dependent — terminals
 * that ignore it render the connector at full default brightness, leaving it
 * louder than the label it introduces — so the theme's `dim` colour is used
 * whenever a theme is registered.
 */
export function dimLine(text: string): string {
	if (boxDimTheme) return boxDimTheme.fg("dim", text);
	return `\x1b[2m${text}\x1b[22m`;
}

/**
 * Light chrome keeps every layout calculation and drops only the drawn frame:
 * each glyph becomes a space of the same width, so labels and content stay in
 * exactly the columns the boxed layout put them in.
 */
let boxChrome: "boxed" | "light" = "boxed";

/** Set by the session coordinator; `shared` never reads feature config directly. */
export function setBoxChrome(mode: "boxed" | "light"): void {
	boxChrome = mode;
}

function boxFrameText(theme: BoxTheme, text: string): string {
	if (boxChrome === "light") return " ".repeat(safeVisibleWidth(text));
	return theme.fg("borderMuted", text);
}

export function boxBorder(theme: BoxTheme, left: string, right: string, width: number): string {
	// An unlabelled rule is pure chrome, so light mode drops the row outright
	// rather than paying a blank line for a frame it does not draw.
	if (boxChrome === "light") return BOX_OMITTED_LINE;
	const renderedWidth = boxWidth(width);
	const innerWidth = renderedWidth - 2;
	return boxFrameText(theme, `${left}${BOX_HORIZONTAL.repeat(innerWidth)}${right}`);
}

/**
 * Border line with an optional label embedded after the left corner and an
 * optional right-side label before the right corner, e.g.:
 *
 *   ╭─── ✎ Edit: src/a.ts ──────────────────╮
 *   ├─── Output ────────────────────────────┤
 *   ╰─── 0.00s · ~45 words ─── configured hint ───╯
 */
export function boxLabeledBorder(
	theme: BoxTheme,
	start: string,
	end: string,
	leftLabel: string,
	rightLabel: string | undefined,
	width: number,
): string {
	const renderedWidth = boxWidth(width);
	let left = leftLabel ?? "";
	const right = rightLabel ?? "";
	let leftWidth = safeVisibleWidth(left);
	const rightWidth = safeVisibleWidth(right);
	const leftOverhead = left ? BOX_LABEL_CAP.length + 2 : 0; // "─── " prefix + " " suffix
	const rightOverhead = right ? 2 : 0; // " " prefix + " " suffix
	let rightFill = right ? BOX_LABELED_RIGHT_DASH_MIN : 0;
	let fill =
		renderedWidth - start.length - end.length - leftOverhead - leftWidth - rightOverhead - rightWidth - rightFill;

	if (right && fill < 0) {
		rightFill = 1;
		fill =
			renderedWidth - start.length - end.length - leftOverhead - leftWidth - rightOverhead - rightWidth - rightFill;
	}

	if (fill < 0) {
		// Too narrow for the labels: truncate the left label, keeping at least one
		// filler dash so the border stays closed.
		const reserved =
			start.length + end.length + leftOverhead + (right ? rightOverhead + rightWidth + rightFill : 0) + 1;
		const maxLeft = renderedWidth - reserved;
		left = maxLeft > 0 ? safeTruncateToWidth(left, maxLeft, "…") : "";
		leftWidth = safeVisibleWidth(left);
		fill =
			renderedWidth -
			start.length -
			end.length -
			(left ? leftWidth + leftOverhead : 0) -
			(right ? rightOverhead + rightWidth + rightFill : 0);
	}

	// Style each border segment separately. Embedded labels carry their own
	// foreground escapes that end in \x1b[39m (reset to the terminal default);
	// applying the border color to the whole line in one wrap would leave every
	// dash after a label in the default color, making one border render with
	// mixed brightness.
	// Light chrome draws no rule: the labels are the line. Left label at column 0,
	// right label flush right, so these rows share the transcript's left margin.
	if (boxChrome === "light") {
		const head = left || right;
		if (!head) return " ".repeat(renderedWidth);
		const tail = left && right ? right : "";
		const gap = Math.max(1, renderedWidth - safeVisibleWidth(head) - safeVisibleWidth(tail));
		return `${head}${" ".repeat(gap)}${tail}`;
	}

	const parts: string[] = [boxFrameText(theme, `${start}${left ? `${BOX_LABEL_CAP} ` : ""}`)];
	if (left) parts.push(left);
	parts.push(boxFrameText(theme, `${left ? " " : ""}${BOX_HORIZONTAL.repeat(Math.max(0, fill))}`));
	if (right) {
		parts.push(boxFrameText(theme, " "), right, boxFrameText(theme, ` ${BOX_HORIZONTAL.repeat(rightFill)}`));
	}
	parts.push(boxFrameText(theme, end));
	return parts.join("");
}

/**
 * Sentinel for a frame padding row that light chrome omits. Content blank lines
 * come through boxLine and stay, so only the frame's own breathing rows go.
 */
export const BOX_OMITTED_LINE = "\x1b[pi-omp-theme:omit]";

/** Drop the padding rows light chrome asked to omit. */
export function dropOmittedLines(lines: string[]): string[] {
	return lines.filter((line) => line !== BOX_OMITTED_LINE);
}

/**
 * Breathing row inside a box. The frame draws no breathing rows in any chrome,
 * so this always yields the omitted-line sentinel; call sites keep marking
 * where such a row would belong.
 */
export function boxBlankLine(_theme: BoxTheme, _width: number): string {
	return BOX_OMITTED_LINE;
}

export function boxLineAligned(theme: BoxTheme, left: string, right: string, width: number): string {
	const renderedWidth = boxWidth(width);
	const contentWidth = boxInnerWidth(renderedWidth);
	const rightWidth = safeVisibleWidth(right);
	const sidePad = " ".repeat(BOX_SIDE_PADDING);

	if (!right || rightWidth >= contentWidth) {
		return boxLine(theme, right || left, renderedWidth);
	}

	const maxLeftWidth = Math.max(1, contentWidth - rightWidth - 1);
	const truncatedLeft = safeTruncateToWidth(left, maxLeftWidth, "…");
	const gap = " ".repeat(Math.max(1, contentWidth - safeVisibleWidth(truncatedLeft) - rightWidth));
	return `${boxFrameText(theme, BOX_VERTICAL)}${sidePad}${truncatedLeft}${gap}${right}${sidePad}${boxFrameText(theme, BOX_VERTICAL)}`;
}

export function boxLine(theme: BoxTheme, content: string, width: number): string {
	const renderedWidth = boxWidth(width);
	// Light chrome draws no frame, so the frame's own inset would leave these lines
	// hanging a few columns right of the boxless renderers (Read, Grep, List) and
	// the transcript would have two left margins. Start at column 0 instead and put
	// the slack on the right; the rendered width is unchanged either way.
	if (boxChrome === "light") {
		const truncated = safeTruncateToWidth(content, renderedWidth, "…");
		return `${truncated}${" ".repeat(Math.max(0, renderedWidth - safeVisibleWidth(truncated)))}`;
	}
	const contentWidth = boxInnerWidth(renderedWidth);
	const fastContent = fastBoxLineContent(content, contentWidth);
	const sidePad = " ".repeat(BOX_SIDE_PADDING);
	if (fastContent) {
		const fill = " ".repeat(Math.max(0, contentWidth - fastContent.visibleWidth));
		return `${boxFrameText(theme, BOX_VERTICAL)}${sidePad}${fastContent.text}${fill}${sidePad}${boxFrameText(theme, BOX_VERTICAL)}`;
	}

	const truncated = safeTruncateToWidth(content, contentWidth, "…");
	const fill = " ".repeat(Math.max(0, contentWidth - safeVisibleWidth(truncated)));
	return `${boxFrameText(theme, BOX_VERTICAL)}${sidePad}${truncated}${fill}${sidePad}${boxFrameText(theme, BOX_VERTICAL)}`;
}

/**
 * Section break between the call and its output — `├─── Output ─────────┤`.
 * The bar spans the full frame and its dashes carry the border colour, so the
 * seam belongs to the box; the label alone is brighter. Callers that already
 * colour their label (diff stats, for instance) keep that colour.
 */
export function boxInsetLabel(
	theme: BoxTheme,
	label: string,
	rightLabel: string | undefined,
	width: number,
): string {
	const styled = label.includes("\x1b") ? label : theme.fg("toolTitle", label);
	return boxLabeledBorder(theme, BOX_DIVIDER_LEFT, BOX_DIVIDER_RIGHT, styled, rightLabel, width);
}

export function boxedWrappedLines(theme: BoxTheme, content: string, width: number): string[] {
	return safeWrapTextWithAnsi(content, boxInnerWidth(width)).map((line) => boxLine(theme, line, width));
}

function boxedTruncatedLine(theme: BoxTheme, content: string, width: number): string {
	return boxLine(theme, safeTruncateToWidth(content, boxInnerWidth(width), "…"), width);
}

type RenderLinesCache = {
	width: number;
	lines: string[];
	/** Resolved call-envelope state when the call uses a lazy resultSeen value. */
	resultSeen?: boolean;
};

function pushBoundedLines(target: string[], lines: string[], maxLines: number): boolean {
	const slots = maxLines - target.length;
	if (slots <= 0) return false;
	if (lines.length > slots) {
		target.push(...lines.slice(0, slots));
		return false;
	}
	target.push(...lines);
	return true;
}

function renderBoxedOutputLines(
	theme: BoxTheme,
	outputLines: string[],
	width: number,
	rawLineBudget = DEFAULT_COLLAPSED_RENDER_LINES,
): string[] {
	const budget = boxedResultRenderBudget(rawLineBudget);
	const headLimit = Math.max(0, Math.min(budget.headLines, budget.maxRenderedLines));
	const tailLimit = Math.max(0, Math.min(budget.tailLines, Math.max(0, budget.maxRenderedLines - headLimit - 1)));
	const head: string[] = [];
	let nextInputIndex = 0;
	let truncated = false;

	for (; nextInputIndex < outputLines.length; nextInputIndex++) {
		// An output "line" may carry embedded newlines (raw tool error messages,
		// JSON payloads). Split before boxing so every fragment gets its own
		// border and truncation — otherwise the box frame visually breaks on the
		// embedded rows.
		const fragments = (outputLines[nextInputIndex] ?? "").split("\n");
		let headExceeded = false;
		for (const fragment of fragments) {
			const line = boxedTruncatedLine(theme, fragment, width);
			if (!pushBoundedLines(head, [line], headLimit)) {
				headExceeded = true;
				break;
			}
		}
		if (headExceeded) {
			truncated = true;
			nextInputIndex++;
			break;
		}
	}

	if (!truncated && nextInputIndex >= outputLines.length) return head;

	const tail: string[] = [];
	const tailStart = Math.max(nextInputIndex, outputLines.length - tailLimit);
	for (let i = tailStart; i < outputLines.length; i++) {
		const fragments = (outputLines[i] ?? "").split("\n");
		for (const fragment of fragments) {
			const line = boxedTruncatedLine(theme, fragment, width);
			tail.push(line);
			if (tail.length > tailLimit) tail.splice(0, tail.length - tailLimit);
		}
	}

	const skippedInputLines = Math.max(0, tailStart - nextInputIndex);
	const skippedText =
		skippedInputLines > 0
			? `… rendered output truncated; ${skippedInputLines} input lines skipped before tail`
			: "… rendered output truncated";
	return [...head, boxLine(theme, theme.fg("muted", skippedText), width), ...tail];
}

export function renderBoxedToolCall(
	theme: BoxTheme,
	toolName: string,
	detailLines: string[],
	options: BoxedRenderOptions = {},
): Component {
	let cache: RenderLinesCache | null = null;
	return {
		invalidate() {
			cache = null;
		},
		render(width: number): string[] {
			const resultSeen =
				typeof options.resultSeen === "function" ? options.resultSeen() : Boolean(options.resultSeen);
			if (cache?.width === width && cache.resultSeen === resultSeen) return cache.lines;
			const title = formatBoxedToolTitle(
				theme,
				toolName,
				options.isError,
				options.isPending ? (options.running ? "running" : "pending") : undefined,
			);
			const headerLabel = options.headerDetail ? `${title}: ${options.headerDetail}` : title;
			const renderedWidth = boxWidth(width);
			const lines = [
				options.showHeader === false
					? boxBorder(theme, BOX_ROUND_TOP_LEFT, BOX_ROUND_TOP_RIGHT, renderedWidth)
					: boxLabeledBorder(theme, BOX_ROUND_TOP_LEFT, BOX_ROUND_TOP_RIGHT, headerLabel, undefined, renderedWidth),
				// The breathing row belongs to the body; without one it just stacks
				// against the divider the result section opens with.
				...(detailLines.length > 0 ? [boxBlankLine(theme, renderedWidth)] : []),
				...detailLines.flatMap((line) => boxedWrappedLines(theme, line, renderedWidth)),
			];
			if (options.isPending && !resultSeen) {
				// Pending/running card: the status is the last content row and the
				// border below it stays plain, so every box in the transcript closes
				// the same way. Once a result renderer has produced a continuation,
				// the box stays open and that continuation closes it.
				const pendingLabel =
					options.pendingLabel ?? theme.fg("dim", `… ${options.pendingText ?? "Waiting for output…"}`);
				lines.push(
					boxLine(theme, pendingLabel, renderedWidth),
					boxBorder(theme, BOX_ROUND_BOTTOM_LEFT, BOX_ROUND_BOTTOM_RIGHT, renderedWidth),
				);
			} else {
				// Leave the box open with trailing breathing room; the result renderer
				// continues it with the result divider.
				lines.push(boxBlankLine(theme, renderedWidth));
			}
			cache = { width, resultSeen, lines: dropOmittedLines(lines) };
			return cache.lines;
		},
	};
}

const COMPACT_FOOTER_KEY = "__piOmpThemeCompactFooter";

export function clearCompactBoxedFooter(state: Record<string, unknown> | undefined): void {
	if (!state || typeof state !== "object") return;
	delete state[COMPACT_FOOTER_KEY];
}

export function renderCompactBoxedToolCall(
	theme: BoxTheme,
	toolName: string,
	detailLine: string,
	options: BoxedRenderOptions = {},
): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			const renderedWidth = boxWidth(width);
			const title = formatBoxedToolTitle(
				theme,
				toolName,
				options.isError,
				options.isPending ? (options.running ? "running" : "pending") : undefined,
			);
			const headerLabel = detailLine ? `${title}: ${detailLine}` : title;
			const compactFooter =
				typeof options.state?.[COMPACT_FOOTER_KEY] === "string" ? options.state[COMPACT_FOOTER_KEY] : "";
			const bodyLines = options.bodyLines ? options.bodyLines(boxInnerWidth(renderedWidth)) : [];
			const lines = [
				boxLabeledBorder(theme, BOX_ROUND_TOP_LEFT, BOX_ROUND_TOP_RIGHT, headerLabel, undefined, renderedWidth),
				...(bodyLines.length > 0
					? bodyLines.map((line) => boxLine(theme, line, renderedWidth))
					: [boxBlankLine(theme, renderedWidth)]),
			];
			// A settled or pending status is content, not chrome: omp closes every
			// frame with a plain border and lets the footer sit on the last row, so
			// the bottom rule reads the same in every box.
			const status =
				compactFooter ||
				(options.isPending
					? (options.pendingLabel ??
						(options.running
							? formatBoxedRunningStatus(theme, undefined)
							: theme.fg("dim", `… ${options.pendingText ?? "Waiting for output…"}`)))
					: "");
			if (status) {
				const footerLine = [status, options.bottomRightLabel ?? ""].filter(Boolean).join("   ");
				lines.push(
					boxLine(theme, footerLine, renderedWidth),
					boxBorder(theme, BOX_ROUND_BOTTOM_LEFT, BOX_ROUND_BOTTOM_RIGHT, renderedWidth),
				);
			}
			// Without a status the box stays open: the result renderer continues it.
			return dropOmittedLines(lines);
		},
	};
}

type BoxedResultBody = Component | ((contentWidth: number) => string[]);

export function renderBoxedToolResult(
	theme: BoxTheme,
	body: BoxedResultBody,
	options: {
		footerLines?: string[];
		emptyText?: string;
		renderLineBudget?: number;
		/** Left-side label embedded in the divider between the call and the result. May be a function of the box width (e.g. for width-dependent layout labels). */
		dividerLabel?: string | ((width: number) => string);
		/** Configured hint pinned to the right of the footer row. */
		expandHint?: string;
		isError?: boolean;
		/** Skip the result divider entirely (streaming continuation into an open call box). */
		showDivider?: boolean;
		/** Error state marker prepended to the body (default `✘ Error`). */
		errorLabel?: string;
	} = {},
): Component {
	let cache: RenderLinesCache | null = null;
	return {
		invalidate() {
			cache = null;
			if (typeof body !== "function") body.invalidate();
		},
		render(width: number): string[] {
			if (cache?.width === width) return cache.lines;
			const renderedWidth = boxWidth(width);
			const maxContentWidth = boxInnerWidth(renderedWidth);
			const bodyLines = typeof body === "function" ? body(maxContentWidth) : body.render(maxContentWidth);
			const errorPrefix = options.isError ? [theme.fg("error", options.errorLabel ?? "✘ Error")] : [];
			const outputLines =
				bodyLines.length > 0
					? [...errorPrefix, ...bodyLines]
					: [theme.fg("muted", `∅ ${options.emptyText ?? "(no output)"}`)];
			// Split embedded newlines before budgeting so raw multi-line messages
			// (tool validation errors, JSON payloads) render as proper bordered
			// rows instead of one "line" whose embedded rows break the frame.
			const outputFragments = outputLines.flatMap((line) => line.split("\n"));
			const footerText = (options.footerLines ?? []).join(" · ");
			const dividerText =
				typeof options.dividerLabel === "function"
					? options.dividerLabel(renderedWidth)
					: (options.dividerLabel ?? "Output");
			const rendered = [
				...(options.showDivider === false
					? []
					: [boxInsetLabel(theme, dividerText, undefined, renderedWidth)]),
				...renderBoxedOutputLines(
					theme,
					outputFragments,
					renderedWidth,
					options.renderLineBudget ?? outputFragments.length,
				),
				...(footerText || options.expandHint
					? [
							boxLineAligned(
								theme,
								theme.fg("dim", footerText),
								options.expandHint ? theme.fg("dim", options.expandHint) : "",
								renderedWidth,
							),
						]
					: []),
				boxBorder(theme, BOX_ROUND_BOTTOM_LEFT, BOX_ROUND_BOTTOM_RIGHT, renderedWidth),
			];
			const visible = dropOmittedLines(rendered);
			cache = { width, lines: visible };
			return visible;
		},
	};
}

export function formatBoxedFooterFromValues(
	theme: BoxTheme,
	elapsedMs: number | undefined,
	output: string,
	extraParts: string[] = [],
): string {
	const wall = elapsedMs === undefined ? "--" : `${(elapsedMs / 1000).toFixed(2)}s`;
	const elapsedPart = theme.fg("text", wall);
	const extraPartList = extraParts.filter(Boolean).map((part) => theme.fg("dim", part));
	const wordsPart = theme.fg("dim", formatBoxedWords(output));
	return [elapsedPart, ...extraPartList, wordsPart].join(theme.fg("dim", " · "));
}

function formatBoxedFooterParts(
	theme: BoxTheme,
	result: MetricResultLike | undefined,
	extraParts: string[] = [],
	elapsedMs?: number,
): string {
	return formatBoxedFooterFromValues(theme, elapsedMs ?? getElapsedMs(result), getTextOutput(result), extraParts);
}

export function formatBoxedFooter(
	theme: BoxTheme,
	result: MetricResultLike | undefined,
	extraParts: string[] = [],
	elapsedMs?: number,
): string {
	return formatBoxedFooterParts(theme, result, extraParts, elapsedMs);
}

export function renderCompactBoxedFooter(
	theme: BoxTheme,
	result: MetricResultLike | undefined,
	options: BoxedRenderOptions = {},
): Component {
	if (options.state && typeof options.state === "object") {
		options.state[COMPACT_FOOTER_KEY] = formatBoxedFooterParts(theme, result, [], options.elapsedMs);
		return { invalidate() {}, render: () => [] };
	}

	return {
		invalidate() {},
		render(width: number): string[] {
			const renderedWidth = boxWidth(width);
			return [
				boxLabeledBorder(
					theme,
					BOX_ROUND_BOTTOM_LEFT,
					BOX_ROUND_BOTTOM_RIGHT,
					formatBoxedFooterParts(theme, result, [], options.elapsedMs),
					undefined,
					renderedWidth,
				),
			];
		},
	};
}

export function formatToolOutputLine(
	theme: BoxTheme,
	line: string,
	color: "toolOutput" | "error" | "text" = "toolOutput",
): string {
	if (color === "error") return theme.fg("error", line);

	const clean = stripAnsi(line);
	if (/^##\s/.test(clean)) return theme.fg("muted", line);
	if (/^\?\?\s/.test(clean))
		return theme.bold ? theme.bold(theme.fg("syntaxVariable", line)) : theme.fg("syntaxVariable", line);

	return theme.fg(color, line);
}

export function selectRenderLines(text: string, maxLines: number, tail = false): { lines: string[]; omitted: number } {
	const source = text ?? "";
	if (!source) return { lines: [], omitted: 0 };
	const limit = Math.max(0, maxLines);
	const selected: string[] = [];
	let lineCount = 0;
	let lineStart = 0;

	for (let i = 0; i <= source.length; i++) {
		if (i < source.length && source[i] !== "\n") continue;
		const rawLine = source.slice(lineStart, i).replace(/\r/g, "");
		lineCount++;
		if (limit > 0) {
			const line = clampRenderLine(rawLine);
			if (tail) {
				selected.push(line);
				if (selected.length > limit) selected.shift();
			} else if (selected.length < limit) {
				selected.push(line);
			}
		}
		lineStart = i + 1;
	}

	if (selected.length === 1 && selected[0] === "") return { lines: [], omitted: 0 };
	return { lines: selected, omitted: Math.max(0, lineCount - selected.length) };
}

export type { MetricResultLike };
// Re-exported metric helpers so renderers import from a single box module.
export { getElapsedMs };

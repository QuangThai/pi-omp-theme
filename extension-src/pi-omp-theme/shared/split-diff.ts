// Adaptive diff renderer — side-by-side (split) for short corresponding
// changes, unified for additions/removals-only diffs and narrow terminals,
// with long runs of unchanged context collapsed into a single
// "⋯ N unchanged lines hidden" row instead of arbitrary output truncation.

import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { RESET_BACKGROUND, stripAnsi } from "./ansi.js";
import { safeTruncateToWidth, safeVisibleWidth } from "./render-budget.js";

// ── Types ──────────────────────────────────────────────────────────

type DiffLine = {
	prefix: "+" | "-" | " ";
	line: string;
	lineNumber: string;
};

type SplitDiffRow = {
	kind: "context" | "changed" | "added" | "removed";
	left?: DiffLine;
	right?: DiffLine;
};

type CellLineKind = "add" | "remove" | "context";

type DiffSpan = { start: number; end: number };

type RgbColor = { r: number; g: number; b: number };

/** Structural view of the theme as used by the diff renderers. */
export interface SplitDiffTheme {
	fg(color: string, text: string): string;
	getBgAnsi?(color: string): string;
	getFgAnsi?(color: string): string;
}

export type DiffMode = "unified" | "split";

type DiffPalette = {
	addRowBgAnsi: string;
	removeRowBgAnsi: string;
	addEmphasisBgAnsi: string;
	removeEmphasisBgAnsi: string;
};

/** A planned render entry: a diff row, a collapsed context gap, or a budget omission. */
type DiffEntry =
	| { kind: "row"; row: SplitDiffRow }
	| { kind: "gap"; hidden: number }
	| { kind: "omitted"; count: number };

// ── Constants ──────────────────────────────────────────────────────

const ESC = "\x1b";
const BG_ANSI_PATTERN = new RegExp(`${ESC}\\[(?:4\\d|10\\d|48;5;\\d{1,3}|48;2;\\d{1,3};\\d{1,3};\\d{1,3}|49)m`, "g");
const CONTROL_CHARS = "\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F";

const ADD_ROW_BACKGROUND_MIX_RATIO = 0.24;
const REMOVE_ROW_BACKGROUND_MIX_RATIO = 0.12;
const ADD_INLINE_EMPHASIS_MIX_RATIO = 0.44;
const REMOVE_INLINE_EMPHASIS_MIX_RATIO = 0.26;

/** Context lines kept on each side of a collapsed run of unchanged lines. */
const CONTEXT_KEEP_DEFAULT = 2;
/** Context runs of this length (or less) are shown in full. */
const CONTEXT_RUN_SHOW_MAX = 4;

/**
 * Minimum diff content width before split mode is even considered. Box chrome
 * (2 borders + 4 side padding) costs ~6 columns, so this corresponds to a
 * ~120-column terminal — below that the two panes wrap too aggressively and
 * unified is always used.
 */
const SPLIT_DIFF_MIN_WIDTH = 114;

// ── ANSI color utilities (diff-specific) ───────────────────────────

function ansi256ToRgb(code: number): RgbColor {
	if (code <= 15) {
		const base16: RgbColor[] = [
			{ r: 0, g: 0, b: 0 },
			{ r: 128, g: 0, b: 0 },
			{ r: 0, g: 128, b: 0 },
			{ r: 128, g: 128, b: 0 },
			{ r: 0, g: 0, b: 128 },
			{ r: 128, g: 0, b: 128 },
			{ r: 0, g: 128, b: 128 },
			{ r: 192, g: 192, b: 192 },
			{ r: 128, g: 128, b: 128 },
			{ r: 255, g: 0, b: 0 },
			{ r: 0, g: 255, b: 0 },
			{ r: 255, g: 255, b: 0 },
			{ r: 0, g: 0, b: 255 },
			{ r: 255, g: 0, b: 255 },
			{ r: 0, g: 255, b: 255 },
			{ r: 255, g: 255, b: 255 },
		];
		return base16[code] ?? { r: 255, g: 255, b: 255 };
	}
	if (code >= 232) {
		const value = Math.max(0, Math.min(255, 8 + (code - 232) * 10));
		return { r: value, g: value, b: value };
	}
	const cube = code - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	const blue = cube % 6;
	const green = Math.floor(cube / 6) % 6;
	const red = Math.floor(cube / 36) % 6;
	return {
		r: levels[red] ?? 0,
		g: levels[green] ?? 0,
		b: levels[blue] ?? 0,
	};
}

function parseAnsiColorCode(ansi: string | undefined): RgbColor | null {
	if (!ansi) return null;
	const rgbMatch = new RegExp(`${ESC}\\[(?:3|4)8;2;(\\d{1,3});(\\d{1,3});(\\d{1,3})m`).exec(ansi);
	if (rgbMatch) {
		const r = Number.parseInt(rgbMatch[1] ?? "0", 10);
		const g = Number.parseInt(rgbMatch[2] ?? "0", 10);
		const b = Number.parseInt(rgbMatch[3] ?? "0", 10);
		return { r, g, b };
	}
	const bitMatch = new RegExp(`${ESC}\\[(?:3|4)8;5;(\\d{1,3})m`).exec(ansi);
	if (bitMatch) {
		const code = Number.parseInt(bitMatch[1] ?? "0", 10);
		return ansi256ToRgb(code);
	}
	return null;
}

function rgbToBgAnsi(color: RgbColor): string {
	const r = Math.max(0, Math.min(255, Math.round(color.r)));
	const g = Math.max(0, Math.min(255, Math.round(color.g)));
	const b = Math.max(0, Math.min(255, Math.round(color.b)));
	return `\x1b[48;2;${r};${g};${b}m`;
}

function mixRgb(base: RgbColor, tint: RgbColor, ratio: number): RgbColor {
	const clamped = Math.max(0, Math.min(1, ratio));
	return {
		r: base.r * (1 - clamped) + tint.r * clamped,
		g: base.g * (1 - clamped) + tint.g * clamped,
		b: base.b * (1 - clamped) + tint.b * clamped,
	};
}

function resolveDiffPalette(theme: SplitDiffTheme): DiffPalette {
	const baseBg = parseAnsiColorCode(theme.getBgAnsi?.("toolSuccessBg")) ??
		parseAnsiColorCode(theme.getBgAnsi?.("toolPendingBg")) ?? { r: 32, g: 35, b: 42 };
	const addFg = parseAnsiColorCode(theme.getFgAnsi?.("toolDiffAdded")) ?? { r: 88, g: 173, b: 88 };
	const removeFg = parseAnsiColorCode(theme.getFgAnsi?.("toolDiffRemoved")) ?? { r: 196, g: 98, b: 98 };

	const addRowBg = mixRgb(baseBg, addFg, ADD_ROW_BACKGROUND_MIX_RATIO);
	const removeRowBg = mixRgb(baseBg, removeFg, REMOVE_ROW_BACKGROUND_MIX_RATIO);
	const addEmphasisBg = mixRgb(baseBg, addFg, ADD_INLINE_EMPHASIS_MIX_RATIO);
	const removeEmphasisBg = mixRgb(baseBg, removeFg, REMOVE_INLINE_EMPHASIS_MIX_RATIO);

	return {
		addRowBgAnsi: rgbToBgAnsi(addRowBg),
		removeRowBgAnsi: rgbToBgAnsi(removeRowBg),
		addEmphasisBgAnsi: rgbToBgAnsi(addEmphasisBg),
		removeEmphasisBgAnsi: rgbToBgAnsi(removeEmphasisBg),
	};
}

// ── ANSI background helpers ────────────────────────────────────────

function keepBackgroundAcrossResets(text: string, rowBgAnsi: string): string {
	if (!text) return text;

	return text.replace(new RegExp(`${ESC}\\[([0-9;]*)m`, "g"), (sequence, rawCodes) => {
		const split = String(rawCodes ?? "")
			.split(";")
			.filter(Boolean);
		const codes = split.length > 0 ? split : ["0"]; // ESC[m == reset
		const hasGlobalReset = codes.includes("0");
		const hasBgReset = codes.includes("49");
		if (!hasGlobalReset && !hasBgReset) return sequence;

		const rebuiltCodes = codes.filter((code: string) => code !== "49");
		const rebuilt = rebuiltCodes.length > 0 ? `\x1b[${rebuiltCodes.join(";")}m` : "";
		return `${rebuilt}${rowBgAnsi}`;
	});
}

function applyBackgroundToVisibleRange(
	ansiText: string,
	start: number,
	end: number,
	backgroundAnsi: string,
	restoreBackgroundAnsi: string,
): string {
	if (!ansiText || start >= end || end <= 0) return ansiText;

	let output = "";
	let visibleIndex = 0;
	let index = 0;
	let inRange = false;

	while (index < ansiText.length) {
		if (ansiText[index] === "\x1b") {
			const sequenceEnd = ansiText.indexOf("m", index);
			if (sequenceEnd !== -1) {
				output += ansiText.slice(index, sequenceEnd + 1);
				index = sequenceEnd + 1;
				continue;
			}
		}

		if (visibleIndex === start && !inRange) {
			output += backgroundAnsi;
			inRange = true;
		}
		if (visibleIndex === end && inRange) {
			output += restoreBackgroundAnsi;
			inRange = false;
		}

		output += ansiText[index] ?? "";
		visibleIndex++;
		index++;
	}

	if (inRange) output += restoreBackgroundAnsi;
	return output;
}

// ── Text utilities ─────────────────────────────────────────────────

function sanitizeSingleLineText(value: string): string {
	return value
		.replace(/\r/g, "")
		.replace(/\n/g, "")
		.replace(new RegExp(`[${CONTROL_CHARS}]`, "g"), "");
}

function stripInlineBreaksPreserveAnsi(value: string): string {
	return value.replace(/\r/g, "").replace(/\n/g, "");
}

function padRight(value: string, width: number): string {
	const visual = safeVisibleWidth(stripAnsi(value));
	if (visual >= width) return value;
	return value + " ".repeat(width - visual);
}

function fitToWidth(value: string, width: number): string {
	return padRight(safeTruncateToWidth(value, width), width);
}

function padRenderedLineWidth(line: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const current = safeVisibleWidth(stripAnsi(line));
	if (current >= safeWidth) return line;
	return line + " ".repeat(safeWidth - current);
}

function wrapPlainText(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const safeText = sanitizeSingleLineText(text);
	if (!safeText) return [""];

	const lines: string[] = [];
	let cursor = 0;

	while (cursor < safeText.length) {
		const remaining = safeText.length - cursor;
		if (remaining <= safeWidth) {
			lines.push(safeText.slice(cursor));
			break;
		}

		const window = safeText.slice(cursor, cursor + safeWidth);
		const breakOnSpace = window.lastIndexOf(" ");

		if (breakOnSpace > 0) {
			const next = breakOnSpace + 1; // keep the space so offsets stay stable for inline diff spans
			lines.push(safeText.slice(cursor, cursor + next));
			cursor += next;
			continue;
		}

		// Fallback for long uninterrupted tokens (paths, hashes, etc.)
		lines.push(window);
		cursor += safeWidth;
	}

	return lines.length > 0 ? lines : [""];
}

// ── Diff parsing ───────────────────────────────────────────────────

function parseLineNumber(value: string): number | undefined {
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function makeDiffLine(prefix: "+" | "-" | " ", lineNumber: string | number | undefined, line: string): DiffLine {
	return {
		prefix,
		lineNumber: lineNumber === undefined ? "" : String(lineNumber),
		line,
	};
}

function parseDiffLine(rawLine: string): DiffLine | undefined {
	// Unified-diff framing is metadata, not content. Without this the `---`/`+++`
	// file headers parse as a removal and an addition, so the rendered rows
	// disagree with the +/- counts in the footer (countDiffStats already skips them).
	if (/^(?:diff --git |index |--- |\+\+\+ |@@)/.test(rawLine)) return undefined;
	const match = rawLine.match(/^([+\- ])\s?(.*)$/);
	if (!match) return undefined;
	const [, prefix, rest = ""] = match;
	if (prefix !== "+" && prefix !== "-" && prefix !== " ") return undefined;

	const gutterMatch = rest.match(/^(\d+)\s(.*)$/);
	const lineNumber = gutterMatch?.[1] ?? "";
	const line = gutterMatch?.[2] ?? rest;
	const cleanLineNumber = sanitizeSingleLineText(lineNumber);
	const cleanLine = sanitizeSingleLineText(line).replace(/\t/g, "    ");
	return { prefix, lineNumber: cleanLineNumber, line: cleanLine };
}

function computeInlineDiffSpans(leftLine: string, rightLine: string): { left: DiffSpan[]; right: DiffSpan[] } {
	if (leftLine === rightLine) return { left: [], right: [] };
	let start = 0;
	const minLen = Math.min(leftLine.length, rightLine.length);
	while (start < minLen && leftLine[start] === rightLine[start]) start++;

	let leftEnd = leftLine.length;
	let rightEnd = rightLine.length;
	while (leftEnd > start && rightEnd > start && leftLine[leftEnd - 1] === rightLine[rightEnd - 1]) {
		leftEnd--;
		rightEnd--;
	}

	const leftSpan = leftEnd > start ? [{ start, end: leftEnd }] : [];
	const rightSpan = rightEnd > start ? [{ start, end: rightEnd }] : [];
	return { left: leftSpan, right: rightSpan };
}

// ── Exported helpers ───────────────────────────────────────────────

export function buildSplitRows(diff: string): SplitDiffRow[] {
	const rows: SplitDiffRow[] = [];
	const pendingLeft: DiffLine[] = [];
	const pendingRight: DiffLine[] = [];
	let oldCursor: number | undefined;
	let newCursor: number | undefined;

	const flushPending = () => {
		while (pendingLeft.length > 0 || pendingRight.length > 0) {
			const left = pendingLeft.shift();
			const right = pendingRight.shift();
			if (left && right) rows.push({ kind: "changed", left, right });
			else if (left) rows.push({ kind: "removed", left });
			else if (right) rows.push({ kind: "added", right });
		}
	};

	for (const rawLine of diff.split("\n")) {
		const parsed = parseDiffLine(rawLine);
		if (!parsed) continue;

		const parsedNum = parseLineNumber(parsed.lineNumber);
		if (parsed.prefix === "-") {
			const oldNum = parsedNum ?? oldCursor;
			if (oldNum !== undefined) oldCursor = oldNum + 1;
			pendingLeft.push(makeDiffLine("-", oldNum, parsed.line));
			continue;
		}
		if (parsed.prefix === "+") {
			const newNum = parsedNum ?? newCursor;
			if (newNum !== undefined) newCursor = newNum + 1;
			pendingRight.push(makeDiffLine("+", newNum, parsed.line));
			continue;
		}

		flushPending();

		const oldNum = parsedNum ?? oldCursor;
		const newNum = newCursor ?? oldNum;
		if (oldNum !== undefined) oldCursor = oldNum + 1;
		if (newNum !== undefined) newCursor = newNum + 1;

		rows.push({
			kind: "context",
			left: makeDiffLine(" ", oldNum, parsed.line),
			right: makeDiffLine(" ", newNum, parsed.line),
		});
	}

	flushPending();
	return rows;
}

export function countDiffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions += 1;
		if (line.startsWith("-")) removals += 1;
	}
	return { additions, removals };
}

export function extractEditedPath(message: string): string | undefined {
	const m = message.match(/Successfully replaced (?:text|\d+ block\(s\)|lines L\d+-\d+) in (.+)\.$/);
	return m?.[1];
}

export function firstText(content: Array<{ type: string; text?: string }>): string {
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			return part.text;
		}
	}
	return "";
}

function longestChangedLineWidth(rows: SplitDiffRow[]): number {
	let longest = 0;
	for (const row of rows) {
		const candidates: string[] = [];
		if (row.kind === "changed") {
			if (row.left) candidates.push(row.left.line);
			if (row.right) candidates.push(row.right.line);
		} else if (row.kind === "added" && row.right) {
			candidates.push(row.right.line);
		} else if (row.kind === "removed" && row.left) {
			candidates.push(row.left.line);
		}
		for (const candidate of candidates) {
			longest = Math.max(longest, safeVisibleWidth(candidate));
		}
	}
	return longest;
}

/**
 * Adaptive layout rule: split side-by-side only when the change has both
 * additions and removals (so both panes carry content), the terminal is wide
 * enough, and no changed line is so long that it would wrap badly in a half
 * pane. Everything else renders as a unified diff.
 */
export function pickDiffMode(
	stats: { additions: number; removals: number },
	rows: SplitDiffRow[],
	width: number,
): DiffMode {
	if (stats.additions <= 0 || stats.removals <= 0) return "unified";
	if (width < SPLIT_DIFF_MIN_WIDTH) return "unified";
	if (longestChangedLineWidth(rows) > width / 2) return "unified";
	return "split";
}

function collapseContextRows(rows: SplitDiffRow[], options: { keep: number; runShowMax?: number }): DiffEntry[] {
	const keep = options.keep;
	const runShowMax = options.runShowMax ?? CONTEXT_RUN_SHOW_MAX;
	const out: DiffEntry[] = [];
	let i = 0;

	while (i < rows.length) {
		const row = rows[i];
		if (row?.kind !== "context") {
			if (row) out.push({ kind: "row", row });
			i++;
			continue;
		}

		let j = i;
		while (j < rows.length && rows[j]?.kind === "context") j++;
		const run = j - i;

		if (run <= runShowMax) {
			for (let k = i; k < j; k++) out.push({ kind: "row", row: rows[k] as SplitDiffRow });
		} else {
			const leading = i === 0;
			const trailing = j >= rows.length;
			const keepHead = leading ? 0 : Math.min(keep, run);
			const keepTail = trailing ? 0 : Math.min(keep, Math.max(0, run - keepHead));
			const hidden = Math.max(0, run - keepHead - keepTail);

			if (keepHead > 0) {
				for (let k = i; k < i + keepHead; k++) out.push({ kind: "row", row: rows[k] as SplitDiffRow });
			}
			if (hidden > 0) out.push({ kind: "gap", hidden });
			if (keepTail > 0) {
				for (let k = j - keepTail; k < j; k++) out.push({ kind: "row", row: rows[k] as SplitDiffRow });
			}
		}

		i = j;
	}

	return out;
}

/**
 * Plan the render entries under a row budget: collapse long context runs with
 * the default padding first, then drop all context if the diff is still too
 * tall, then finally trim the head and append an omission marker. The budget
 * applies to entries (each renders at least one line, gaps included).
 */
function planEntries(rows: SplitDiffRow[], maxRows: number): DiffEntry[] {
	const budget = Math.max(1, maxRows);

	let entries = collapseContextRows(rows, { keep: CONTEXT_KEEP_DEFAULT });
	if (entries.length <= budget) return entries;

	entries = collapseContextRows(rows, { keep: 0, runShowMax: 0 });
	if (entries.length <= budget) return entries;

	const kept = entries.slice(0, Math.max(1, budget - 1));
	const omitted = Math.max(0, entries.length - kept.length);
	if (omitted <= 0) return kept;
	return [...kept, { kind: "omitted", count: omitted }];
}

function formatGapLabel(hidden: number): string {
	return `⋯ ${hidden} unchanged ${hidden === 1 ? "line" : "lines"} hidden`;
}

function formatOmittedLabel(count: number): string {
	return `⋯ ${count} ${count === 1 ? "line" : "lines"} omitted · Ctrl+O to show full diff`;
}

// ── DiffRenderContext ──────────────────────────────────────────────
// Shared per-instance state: palette, gutter width, syntax-highlight cache,
// and inline-emphasis spans for paired changed rows.

class DiffRenderContext {
	readonly lineNumberWidth: number;
	readonly palette: DiffPalette;
	readonly containerBgAnsi: string;
	private readonly highlightCache = new Map<string, string>();
	private readonly inlineHighlights = new WeakMap<DiffLine, DiffSpan[]>();

	constructor(
		private readonly theme: SplitDiffTheme,
		rows: SplitDiffRow[],
		private readonly language?: string,
	) {
		let maxDigits = 3;
		for (const row of rows) {
			const leftDigits = row.left?.lineNumber.trim().length ?? 0;
			const rightDigits = row.right?.lineNumber.trim().length ?? 0;
			maxDigits = Math.max(maxDigits, leftDigits, rightDigits);

			if (row.kind === "changed" && row.left && row.right) {
				const spans = computeInlineDiffSpans(row.left.line, row.right.line);
				if (spans.left.length > 0) this.inlineHighlights.set(row.left, spans.left);
				if (spans.right.length > 0) this.inlineHighlights.set(row.right, spans.right);
			}
		}
		this.lineNumberWidth = maxDigits;
		this.palette = resolveDiffPalette(theme);
		// The boxed renderers deliberately drop the tool background slab
		// (see neutralizeToolContainerBackground), so closing a tinted row with the
		// theme background paints a dark band the rest of the block does not have.
		// Close to the terminal default instead: the padding then blends away.
		this.containerBgAnsi = RESET_BACKGROUND;
	}

	fg(color: string, text: string): string {
		return this.theme.fg(color, text);
	}

	inlineSpans(line: DiffLine): DiffSpan[] {
		return this.inlineHighlights.get(line) ?? [];
	}

	syntaxHighlight(line: string): string {
		if (!this.language) return stripInlineBreaksPreserveAnsi(line);
		const safeLine = sanitizeSingleLineText(line);
		const key = `${this.language}\n${safeLine}`;
		const cached = this.highlightCache.get(key);
		if (cached) return cached;

		let highlighted = safeLine;
		try {
			highlighted = highlightCode(safeLine, this.language)[0] ?? safeLine;
			highlighted = stripInlineBreaksPreserveAnsi(highlighted).replace(BG_ANSI_PATTERN, "");
		} catch {
			highlighted = safeLine;
		}
		this.highlightCache.set(key, highlighted);
		return highlighted;
	}
}

// ── Unified diff renderer ──────────────────────────────────────────
// One column: marker + gutter + content, with added/removed lines carrying
// the same row backgrounds as the split view. Changed rows expand back into
// their removed-then-added pair (like `git diff`).

class UnifiedDiffRenderer {
	constructor(
		private readonly ctx: DiffRenderContext,
		private readonly entries: DiffEntry[],
	) {}

	private gapLine(entry: { hidden: number }, width: number): string {
		return padRenderedLineWidth(this.ctx.fg("muted", formatGapLabel(entry.hidden)), width);
	}

	private omittedLine(entry: { count: number }, width: number): string {
		return padRenderedLineWidth(this.ctx.fg("muted", formatOmittedLabel(entry.count)), width);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const prefixWidth = 1 + 1 + this.ctx.lineNumberWidth + 2; // marker + space + gutter + 2 spaces
		const codeWidth = Math.max(1, safeWidth - prefixWidth);
		const lines: string[] = [];

		for (const entry of this.entries) {
			if (entry.kind === "gap") {
				lines.push(this.gapLine(entry, safeWidth));
				continue;
			}
			if (entry.kind === "omitted") {
				lines.push(this.omittedLine(entry, safeWidth));
				continue;
			}
			lines.push(...this.rowLines(entry.row, codeWidth, safeWidth));
		}

		return lines;
	}

	private rowLines(row: SplitDiffRow, codeWidth: number, width: number): string[] {
		const segments: Array<{ kind: CellLineKind; line: DiffLine }> = [];
		if (row.kind === "changed") {
			if (row.left) segments.push({ kind: "remove", line: row.left });
			if (row.right) segments.push({ kind: "add", line: row.right });
		} else if (row.kind === "added" && row.right) {
			segments.push({ kind: "add", line: row.right });
		} else if (row.kind === "removed" && row.left) {
			segments.push({ kind: "remove", line: row.left });
		} else {
			const line = row.left ?? row.right;
			if (line) segments.push({ kind: "context", line });
		}

		const out: string[] = [];
		for (const segment of segments) {
			out.push(...this.segmentLines(segment.kind, segment.line, codeWidth, width));
		}
		return out;
	}

	private segmentLines(kind: CellLineKind, line: DiffLine, codeWidth: number, width: number): string[] {
		const isAdd = kind === "add";
		const isRemove = kind === "remove";
		const blank = line.line === "";
		// Blank added/removed lines render like context (no tinted band), but the
		// +/- marker still shows that a line was inserted/removed.
		const visualKind: CellLineKind = kind === "context" || blank ? "context" : kind;
		const markerChar = kind === "context" ? " " : isAdd ? "+" : "-";
		const markerColor = isAdd ? "toolDiffAdded" : isRemove ? "toolDiffRemoved" : "dim";
		const gutterColor = visualKind === "context" ? "dim" : isAdd ? "toolDiffAdded" : "toolDiffRemoved";
		const gutter = line.lineNumber.trim().padStart(this.ctx.lineNumberWidth, " ");

		const firstPrefixAnsi = `${this.ctx.fg(markerColor, markerChar)} ${this.ctx.fg(gutterColor, gutter)}  `;
		const firstPrefixPlain = `${markerChar} ${gutter}  `;
		const contPrefixAnsi = `${this.ctx.fg("dim", " ")} ${this.ctx.fg("dim", " ".repeat(this.ctx.lineNumberWidth))}  `;
		const contPrefixPlain = ` ${" ".repeat(1 + this.ctx.lineNumberWidth)}  `;

		const rowBg =
			visualKind === "add"
				? this.ctx.palette.addRowBgAnsi
				: visualKind === "remove"
					? this.ctx.palette.removeRowBgAnsi
					: undefined;

		// Word-level emphasis is what makes a changed line readable at a glance:
		// without it the eye has to compare two full lines to find the edit. The
		// split renderer already does this; unified is the layout most terminals
		// actually get, so it needs the same treatment.
		const emphasisBg =
			visualKind === "add"
				? this.ctx.palette.addEmphasisBgAnsi
				: visualKind === "remove"
					? this.ctx.palette.removeEmphasisBgAnsi
					: undefined;
		const spans = this.ctx.inlineSpans(line);

		const plainSegments = wrapPlainText(line.line, codeWidth);
		const out: string[] = [];
		let consumed = 0;

		for (let i = 0; i < plainSegments.length; i++) {
			const prefixAnsi = i === 0 ? firstPrefixAnsi : contPrefixAnsi;
			const prefixPlain = i === 0 ? firstPrefixPlain : contPrefixPlain;
			const plainSegment = plainSegments[i] ?? "";
			let segment = this.ctx.syntaxHighlight(plainSegment);

			if (spans.length > 0 && emphasisBg) {
				const segmentStart = consumed;
				// Applied back to front so earlier offsets stay valid.
				for (let si = spans.length - 1; si >= 0; si--) {
					const span = spans[si];
					if (!span) continue;
					const localStart = Math.max(0, span.start - segmentStart);
					const localEnd = Math.min(plainSegment.length, span.end - segmentStart);
					if (localEnd > localStart) {
						segment = applyBackgroundToVisibleRange(
							segment,
							localStart,
							localEnd,
							emphasisBg,
							rowBg ?? this.ctx.containerBgAnsi,
						);
					}
				}
			}

			segment = fitToWidth(segment, codeWidth);

			let rendered = prefixAnsi + segment;
			const expectedWidth = safeVisibleWidth(prefixPlain) + codeWidth;
			const currentWidth = safeVisibleWidth(stripAnsi(rendered));
			if (currentWidth < expectedWidth) {
				rendered += " ".repeat(expectedWidth - currentWidth);
			}

			if (rowBg) {
				rendered = `${rowBg}${keepBackgroundAcrossResets(rendered, rowBg)}${this.ctx.containerBgAnsi}`;
			}
			out.push(padRenderedLineWidth(rendered, width));
			consumed += plainSegment.length;
		}

		return out;
	}
}

// ── Split (side-by-side) diff renderer ─────────────────────────────

class SplitDiffRenderer {
	constructor(
		private readonly ctx: DiffRenderContext,
		private readonly entries: DiffEntry[],
	) {}

	private getCellLineKind(kind: SplitDiffRow["kind"], side: "left" | "right"): CellLineKind {
		if (kind === "changed") return side === "left" ? "remove" : "add";
		if (kind === "removed" && side === "left") return "remove";
		if (kind === "added" && side === "right") return "add";
		return "context";
	}

	private getVisualLineKind(kind: SplitDiffRow["kind"], side: "left" | "right", line?: DiffLine): CellLineKind {
		const base = this.getCellLineKind(kind, side);
		if ((kind === "added" || kind === "removed") && (line?.line ?? "") === "") {
			return "context";
		}
		return base;
	}

	private getNumberColor(lineKind: CellLineKind): "toolDiffRemoved" | "toolDiffAdded" | "dim" {
		if (lineKind === "remove") return "toolDiffRemoved";
		if (lineKind === "add") return "toolDiffAdded";
		return "dim";
	}

	private getRowBackground(lineKind: CellLineKind): string | undefined {
		if (lineKind === "add") return this.ctx.palette.addRowBgAnsi;
		if (lineKind === "remove") return this.ctx.palette.removeRowBgAnsi;
		return undefined;
	}

	private getEmphasisBackground(lineKind: CellLineKind): string | undefined {
		if (lineKind === "add") return this.ctx.palette.addEmphasisBgAnsi;
		if (lineKind === "remove") return this.ctx.palette.removeEmphasisBgAnsi;
		return undefined;
	}

	private getCellFillBackground(kind: SplitDiffRow["kind"], side: "left" | "right"): string | undefined {
		switch (kind) {
			case "changed":
				return side === "left" ? this.ctx.palette.removeRowBgAnsi : this.ctx.palette.addRowBgAnsi;
			case "removed":
				return side === "left" ? this.ctx.palette.removeRowBgAnsi : undefined;
			case "added":
				return side === "right" ? this.ctx.palette.addRowBgAnsi : undefined;
			default:
				return undefined;
		}
	}

	private blankCell(kind: SplitDiffRow["kind"], side: "left" | "right", columnWidth: number): string {
		const lineKind = this.getCellLineKind(kind, side);
		const markerChar = lineKind === "add" || lineKind === "remove" ? "▌" : " ";
		const markerColor =
			lineKind === "add" ? "toolDiffAdded" : lineKind === "remove" ? "toolDiffRemoved" : "borderMuted";
		const marker = this.ctx.fg(markerColor, markerChar);
		const lineNumber = this.ctx.fg("dim", " ".repeat(this.ctx.lineNumberWidth));
		const divider = this.ctx.fg("borderMuted", " │ ");
		const prefix = `${marker} ${lineNumber}${divider}`;
		const prefixPlain = `${markerChar} ${" ".repeat(this.ctx.lineNumberWidth)} │ `;
		const tailWidth = Math.max(0, columnWidth - safeVisibleWidth(prefixPlain));
		let rendered = prefix + " ".repeat(tailWidth);

		const bg = this.getCellFillBackground(kind, side);
		if (!bg) return padRenderedLineWidth(rendered, columnWidth);
		rendered = `${bg}${keepBackgroundAcrossResets(rendered, bg)}${this.ctx.containerBgAnsi}`;
		return padRenderedLineWidth(rendered, columnWidth);
	}

	private formatCellLines(
		kind: SplitDiffRow["kind"],
		side: "left" | "right",
		line: DiffLine | undefined,
		columnWidth: number,
	): string[] {
		if (!line) return [this.blankCell(kind, side, columnWidth)];

		const lineKind = this.getVisualLineKind(kind, side, line);
		const markerChar = lineKind === "add" || lineKind === "remove" ? "▌" : " ";
		const markerColor =
			lineKind === "add" ? "toolDiffAdded" : lineKind === "remove" ? "toolDiffRemoved" : "borderMuted";
		const lineNumber = line.lineNumber.trim().padStart(this.ctx.lineNumberWidth, " ");

		const firstPrefixAnsi =
			this.ctx.fg(markerColor, markerChar) +
			" " +
			this.ctx.fg(this.getNumberColor(lineKind), lineNumber) +
			this.ctx.fg("borderMuted", " │ ");
		const firstPrefixPlain = `${markerChar} ${lineNumber} │ `;

		const contPrefixAnsi =
			this.ctx.fg(markerColor, markerChar) +
			" " +
			this.ctx.fg("dim", " ".repeat(this.ctx.lineNumberWidth)) +
			this.ctx.fg("borderMuted", " │ ");
		const contPrefixPlain = `${markerChar} ${" ".repeat(this.ctx.lineNumberWidth)} │ `;

		const codeWidth = Math.max(1, columnWidth - safeVisibleWidth(firstPrefixPlain));
		const rowBg = this.getRowBackground(lineKind);
		const emphasisBg = this.getEmphasisBackground(lineKind);

		const plainSegments = wrapPlainText(line.line, codeWidth);
		const lines: string[] = [];
		const spans = this.ctx.inlineSpans(line);

		let consumed = 0;
		for (let i = 0; i < plainSegments.length; i++) {
			const prefixAnsi = i === 0 ? firstPrefixAnsi : contPrefixAnsi;
			const prefixPlain = i === 0 ? firstPrefixPlain : contPrefixPlain;
			const plainSegment = plainSegments[i] ?? "";
			let segment = this.ctx.syntaxHighlight(plainSegment);

			if (spans.length > 0 && emphasisBg) {
				const segmentStart = consumed;
				for (let si = spans.length - 1; si >= 0; si--) {
					const span = spans[si];
					if (!span) continue;
					const localStart = Math.max(0, span.start - segmentStart);
					const localEnd = Math.min(plainSegment.length, span.end - segmentStart);
					if (localEnd > localStart) {
						segment = applyBackgroundToVisibleRange(
							segment,
							localStart,
							localEnd,
							emphasisBg,
							rowBg ?? this.ctx.containerBgAnsi,
						);
					}
				}
			}

			segment = fitToWidth(segment, codeWidth);
			let rendered = prefixAnsi + segment;

			// Defensive pad if prefix widths diverge because of unicode widths
			const expectedWidth = safeVisibleWidth(prefixPlain) + codeWidth;
			const currentWidth = safeVisibleWidth(stripAnsi(rendered));
			if (currentWidth < expectedWidth) {
				rendered += " ".repeat(expectedWidth - currentWidth);
			}

			if (rowBg) {
				rendered = `${rowBg}${keepBackgroundAcrossResets(rendered, rowBg)}${this.ctx.containerBgAnsi}`;
			}
			lines.push(padRenderedLineWidth(rendered, columnWidth));
			consumed += plainSegment.length;
		}

		return lines;
	}

	private gapLine(entry: { hidden: number }, width: number): string {
		return padRenderedLineWidth(this.ctx.fg("muted", formatGapLabel(entry.hidden)), width);
	}

	private omittedLine(entry: { count: number }, width: number): string {
		return padRenderedLineWidth(this.ctx.fg("muted", formatOmittedLabel(entry.count)), width);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const columnSeparator = this.ctx.fg("borderMuted", " │ ");
		const separatorWidth = safeVisibleWidth(stripAnsi(columnSeparator));
		const leftWidth = Math.max(20, Math.floor((safeWidth - separatorWidth) / 2));
		const rightWidth = Math.max(20, safeWidth - separatorWidth - leftWidth);

		const formatHeaderCell = (label: string, columnWidth: number): string => {
			// Keep marker+space columns, then place label inside the line-number column.
			const markerPad = "  ";
			const lineNumberLabel = fitToWidth(label, this.ctx.lineNumberWidth);
			const prefixAnsi = this.ctx.fg("dim", markerPad) + this.ctx.fg("dim", lineNumberLabel) + this.ctx.fg("borderMuted", " │ ");
			const prefixPlain = `${markerPad}${stripAnsi(lineNumberLabel)} │ `;
			const codeWidth = Math.max(0, columnWidth - safeVisibleWidth(prefixPlain));
			return padRenderedLineWidth(prefixAnsi + " ".repeat(codeWidth), columnWidth);
		};

		const lines: string[] = [];
		lines.push(
			padRenderedLineWidth(
				formatHeaderCell("old", leftWidth) + columnSeparator + formatHeaderCell("new", rightWidth),
				safeWidth,
			),
		);

		for (const entry of this.entries) {
			if (entry.kind === "gap") {
				lines.push(this.gapLine(entry, safeWidth));
				continue;
			}
			if (entry.kind === "omitted") {
				lines.push(this.omittedLine(entry, safeWidth));
				continue;
			}

			const row = entry.row;
			const leftCellLines = this.formatCellLines(row.kind, "left", row.left, leftWidth);
			const rightCellLines = this.formatCellLines(row.kind, "right", row.right, rightWidth);
			const rowHeight = Math.max(leftCellLines.length, rightCellLines.length);

			for (let i = 0; i < rowHeight; i++) {
				const fallbackKind: SplitDiffRow["kind"] = row.kind === "changed" ? "context" : row.kind;
				const leftCell = leftCellLines[i] ?? this.blankCell(fallbackKind, "left", leftWidth);
				const rightCell = rightCellLines[i] ?? this.blankCell(fallbackKind, "right", rightWidth);
				const joined = padRenderedLineWidth(leftCell + columnSeparator + rightCell, safeWidth);
				lines.push(joined);
			}
		}

		return lines;
	}
}

// ── AdaptiveDiffComponent ──────────────────────────────────────────

/**
 * Boxed diff component that picks unified vs split layout per render width
 * (see `pickDiffMode`) and collapses long unchanged context instead of
 * truncating arbitrarily.
 */
export class AdaptiveDiffComponent implements Component {
	private cacheWidth: number | undefined;
	private cacheLines: string[] | undefined;
	private readonly ctx: DiffRenderContext;
	private readonly stats: { additions: number; removals: number };
	private readonly unified: UnifiedDiffRenderer;
	private readonly split: SplitDiffRenderer;
	private readonly collapsed: boolean;

	constructor(
		theme: SplitDiffTheme,
		private readonly rows: SplitDiffRow[],
		maxRows: number,
		language?: string,
	) {
		this.ctx = new DiffRenderContext(theme, rows, language);
		this.stats = { additions: 0, removals: 0 };
		for (const row of rows) {
			if (row.kind === "added" || row.kind === "changed") this.stats.additions++;
			if (row.kind === "removed" || row.kind === "changed") this.stats.removals++;
		}
		const entries = planEntries(rows, maxRows);
		this.collapsed = entries.some((entry) => entry.kind !== "row");
		this.unified = new UnifiedDiffRenderer(this.ctx, entries);
		this.split = new SplitDiffRenderer(this.ctx, entries);
	}

	/** True when any unchanged context was collapsed or rows were omitted. */
	hasCollapsed(): boolean {
		return this.collapsed;
	}

	modeForWidth(width: number): DiffMode {
		return pickDiffMode(this.stats, this.rows, Math.max(20, width));
	}

	render(width: number): string[] {
		if (this.cacheWidth === width && this.cacheLines) return this.cacheLines;

		const safeWidth = Math.max(20, width);
		const mode = this.modeForWidth(safeWidth);
		const lines = mode === "split" ? this.split.render(safeWidth) : this.unified.render(safeWidth);

		this.cacheWidth = width;
		this.cacheLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cacheWidth = undefined;
		this.cacheLines = undefined;
	}
}

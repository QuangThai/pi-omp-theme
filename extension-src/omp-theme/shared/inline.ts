// Inline tool presentation primitives (Claude Code's transcript).
//
// A tool block is a header row `● Name(args)` whose marker carries the status
// colour, followed by a result gutter: the first body row opens with `  ⎿  `
// and the rest hang under it. There is no frame and no divider; every row is
// truncated to the width it is painted at, so a block never overflows.
//
// These primitives only format rows. State (elapsed tickers, result phases,
// registries) stays with the tool renderers that call them.

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme } from "./box.js";
import { formatElapsedMs } from "./elapsed.js";
import { fitExpandHint, toolExpandHint } from "./keybinding-hints.js";
import { safeTruncateToWidth, safeVisibleWidth } from "./render-budget.js";

export interface InlineGlyphs {
	/** Leading status marker of a block (`●`). */
	readonly marker: string;
	/** Result gutter that opens the body under a header (`⎿`). */
	readonly gutter: string;
	/** Checklist item that is done (`☒`). */
	readonly done: string;
	/** Checklist item that is still open (`☐`). */
	readonly open: string;
}

// U+25CF, not U+23FA: the record circle has an emoji presentation that many
// terminal fonts lack, so it is drawn from a fallback font wider than its cell
// and crowds the title beside it.
const DEFAULT_GLYPHS: InlineGlyphs = Object.freeze({ marker: "●", gutter: "⎿", done: "☒", open: "☐" });
let glyphs: InlineGlyphs = DEFAULT_GLYPHS;

/** Set by the session coordinator from the resolved glyph mode (nerd/unicode/ascii). */
export function setInlineGlyphs(next: Partial<InlineGlyphs> | undefined): void {
	glyphs = Object.freeze({ ...DEFAULT_GLYPHS, ...next });
}

export function inlineGlyphs(): InlineGlyphs {
	return glyphs;
}

export type InlineStatus = "pending" | "running" | "success" | "error";

const STATUS_COLOR: Readonly<Record<InlineStatus, string>> = {
	pending: "dim",
	running: "accent",
	success: "success",
	error: "error",
};

/** Columns in front of the gutter glyph, and between it and the body. */
const GUTTER_LEAD = 2;
const GUTTER_GAP = 2;

/** Status from Pi's renderer context: still streaming, failed, or settled. */
export function inlineStatus(context: { isPartial: boolean; isError: boolean; executionStarted: boolean }): InlineStatus {
	if (context.isError) return "error";
	if (context.isPartial) return context.executionStarted ? "running" : "pending";
	return "success";
}

export function inlineMarker(theme: BoxTheme, status: InlineStatus): string {
	return theme.fg(STATUS_COLOR[status], glyphs.marker);
}

function bold(theme: BoxTheme, text: string): string {
	return typeof theme.bold === "function" ? theme.bold(text) : text;
}

function truncate(text: string, width: number): string {
	return safeTruncateToWidth(text, Math.max(1, width), "…");
}

/** Truncate a body row, keeping a trailing expand hint in view. */
function fitRow(row: string, width: number): string {
	return truncate(fitExpandHint(row, width), width);
}

/**
 * `● Name(args)`. When the row is too narrow the arguments give way first and
 * the closing parenthesis stays, so the call still reads as a call.
 */
export function inlineHeaderLine(
	theme: BoxTheme,
	status: InlineStatus,
	name: string,
	args: string,
	width: number,
): string {
	const lead = `${inlineMarker(theme, status)} ${bold(theme, theme.fg(status === "error" ? "error" : "toolTitle", name))}`;
	const flat = args.replace(/\s*\n\s*/g, " ").trim();
	if (!flat) return truncate(lead, width);
	const open = theme.fg("dim", "(");
	const close = theme.fg("dim", ")");
	const room = width - safeVisibleWidth(lead) - 2;
	if (room < 2) return truncate(lead, width);
	return `${lead}${open}${theme.fg("text", truncate(flat, room))}${close}`;
}

/** Width of the gutter prefix (`  ⎿  `), the column every body row starts at. */
export function inlineBodyIndent(): number {
	return GUTTER_LEAD + safeVisibleWidth(glyphs.gutter) + GUTTER_GAP;
}

/** Content width available to body rows under a gutter. */
export function inlineContentWidth(width: number): number {
	return Math.max(1, width - inlineBodyIndent());
}

/**
 * Hang `rows` under the result gutter. The first row opens it (`  ⎿  `) unless
 * `continues` says an earlier component already did; embedded newlines split
 * into their own rows.
 */
export function inlineGutterLines(
	theme: BoxTheme,
	rows: readonly string[],
	width: number,
	options: { continues?: boolean } = {},
): string[] {
	const indent = inlineBodyIndent();
	const flat = rows.flatMap((row) => row.split("\n"));
	if (width <= indent) return flat.map((row) => fitRow(row, width));
	const opener = `${" ".repeat(GUTTER_LEAD)}${theme.fg("dim", glyphs.gutter)}${" ".repeat(GUTTER_GAP)}`;
	const hang = " ".repeat(indent);
	const contentWidth = width - indent;
	return flat.map((row, index) => `${index === 0 && !options.continues ? opener : hang}${fitRow(row, contentWidth)}`);
}

/** Dim `a · b · c` metadata row; empty parts are skipped. */
export function inlineMeta(theme: BoxTheme, parts: ReadonlyArray<string | undefined>): string {
	return parts
		.filter((part): part is string => Boolean(part))
		.map((part) => (part.includes("\x1b") ? part : theme.fg("dim", part)))
		.join(theme.fg("dim", " · "));
}

/** Elapsed for a metadata row (`234ms`, `2.2s`, `14s`), or undefined when unknown. */
export function inlineElapsed(elapsedMs: number | undefined): string | undefined {
	const text = formatElapsedMs(elapsedMs);
	return text || undefined;
}

/** `Running… 2.4s` while a tool executes (the time appears after the first second). */
export function inlineRunningRow(theme: BoxTheme, elapsedMs: number | undefined): string {
	const elapsed = elapsedMs !== undefined && elapsedMs >= 1000 ? ` ${formatElapsedMs(elapsedMs)}` : "";
	return theme.fg("dim", `Running…${elapsed}`);
}

/** `… +N lines · Ctrl+O to expand` (no shortcut once expanded or unbound). */
export function inlineMoreRow(theme: BoxTheme, omitted: number, expanded: boolean, unit = "line"): string {
	const noun = omitted === 1 ? unit : `${unit}s`;
	const hint = expanded ? "" : toolExpandHint();
	return theme.fg("dim", `… +${omitted} ${noun}${hint ? ` · ${hint}` : ""}`);
}

/** Header row plus optional gutter body, as a Pi component. */
export function inlineBlock(
	theme: BoxTheme,
	header: { status: InlineStatus; name: string; args: string } | undefined,
	body?: (contentWidth: number) => string[],
	options: { continues?: boolean } = {},
): Component {
	let cache: { width: number; lines: string[] } | undefined;
	return {
		invalidate() {
			cache = undefined;
		},
		render(width: number): string[] {
			if (cache?.width === width) return cache.lines;
			const lines: string[] = [];
			if (header) lines.push(inlineHeaderLine(theme, header.status, header.name, header.args, width));
			const rows = body ? body(inlineContentWidth(width)) : [];
			if (rows.length > 0) lines.push(...inlineGutterLines(theme, rows, width, options));
			cache = { width, lines };
			return lines;
		},
	};
}

/**
 * Hang a component that renders its own body (a diff view, a tool's own result
 * record) under the result gutter, painted at the gutter's content width.
 * `continues` hangs it under a gutter an earlier component already opened.
 */
export function inlineGutterComponent(
	theme: BoxTheme,
	component: Component,
	options: { continues?: boolean } = {},
): Component {
	const block = inlineBlock(theme, undefined, (contentWidth) => component.render(contentWidth), options);
	return {
		invalidate() {
			component.invalidate();
			block.invalidate();
		},
		render: (width: number) => block.render(width),
	};
}

/** Zero-height component (a result that adds nothing under its header). */
export function emptyInlineComponent(): Component {
	return {
		invalidate() {},
		render() {
			return [];
		},
	};
}

const LABEL_KEYS = ["header", "title", "question", "content", "label", "name", "text"];

/** `Fix, Scope +1` for a list of objects that carry a label; undefined otherwise. */
function listLabels(items: readonly unknown[]): string | undefined {
	const labels: string[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") return undefined;
		const record = item as Record<string, unknown>;
		const label = LABEL_KEYS.map((key) => record[key]).find((value) => typeof value === "string" && value.trim());
		if (typeof label !== "string") return undefined;
		labels.push(label.replace(/\s+/g, " ").trim());
	}
	if (labels.length === 0) return undefined;
	const shown = labels.slice(0, 2).join(", ");
	return labels.length > 2 ? `${shown} +${labels.length - 2}` : shown;
}

const PRIMARY_ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "prompt", "description", "name"];
const MAX_ARG_VALUE = 120;

function argValue(value: unknown): string {
	if (value === undefined) return "";
	if (value === null) return "null";
	if (typeof value === "string") {
		const firstLine = value.replace(/\r/g, "").split("\n")[0] ?? "";
		const clipped = firstLine.length > MAX_ARG_VALUE ? `${firstLine.slice(0, MAX_ARG_VALUE)}…` : firstLine;
		return firstLine !== value.replace(/\r/g, "").trimEnd() ? `${clipped} …` : clipped;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (Array.isArray(value)) return listLabels(value) ?? (value.length === 1 ? "1 item" : `${value.length} items`);
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return keys.length === 0 ? "{}" : "{…}";
	}
	return String(value);
}

/**
 * One-line argument summary for a call header: a lone or primary argument
 * shows its value, several arguments read `key: value, key: value`.
 */
export function inlineArgsSummary(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args !== "object" || Array.isArray(args)) return argValue(args);
	const entries = Object.entries(args as Record<string, unknown>).filter(([, value]) => value !== undefined);
	if (entries.length === 0) return "";
	if (entries.length === 1) return argValue(entries[0]?.[1]);
	const primary = entries.find(([key, value]) => PRIMARY_ARG_KEYS.includes(key) && typeof value === "string");
	const ordered = primary ? [primary, ...entries.filter((entry) => entry !== primary)] : entries;
	return ordered.map(([key, value]) => `${key}: ${argValue(value)}`).join(", ");
}

export interface ChecklistItem {
	readonly text: string;
	readonly state: "done" | "active" | "open" | "cancelled";
}

const DONE_STATES = new Set(["completed", "complete", "done", "finished"]);
const ACTIVE_STATES = new Set(["in_progress", "in-progress", "inprogress", "active", "doing", "running"]);
const CANCELLED_STATES = new Set(["cancelled", "canceled", "skipped", "dropped"]);

/**
 * A todo list in tool arguments (`todos: [{ content, status }]`), recognised
 * by shape rather than tool name so any todo extension renders as a checklist.
 */
export function checklistFromArgs(args: unknown): ChecklistItem[] | undefined {
	if (!args || typeof args !== "object") return undefined;
	const todos = (args as { todos?: unknown }).todos;
	if (!Array.isArray(todos) || todos.length === 0) return undefined;
	const items: ChecklistItem[] = [];
	for (const todo of todos) {
		if (!todo || typeof todo !== "object") return undefined;
		const record = todo as Record<string, unknown>;
		const text = [record.content, record.title, record.text, record.task].find((value) => typeof value === "string");
		if (typeof text !== "string") return undefined;
		const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
		const done = DONE_STATES.has(status) || record.done === true || record.completed === true;
		const state = done
			? "done"
			: CANCELLED_STATES.has(status)
				? "cancelled"
				: ACTIVE_STATES.has(status)
					? "active"
					: "open";
		items.push({ text, state });
	}
	return items;
}

export function checklistRows(theme: BoxTheme & { strikethrough?(text: string): string }, items: readonly ChecklistItem[]): string[] {
	return items.map((item) => {
		if (item.state === "done" || item.state === "cancelled") {
			const text = typeof theme.strikethrough === "function" ? theme.strikethrough(item.text) : item.text;
			return `${theme.fg(item.state === "done" ? "success" : "dim", glyphs.done)} ${theme.fg("dim", text)}`;
		}
		if (item.state === "active") return `${theme.fg("accent", glyphs.open)} ${bold(theme, theme.fg("text", item.text))}`;
		return `${theme.fg("dim", glyphs.open)} ${theme.fg("text", item.text)}`;
	});
}

/** Rows of a text body that fit the line budget, head or tail first. */
export function inlinePreview(
	text: string,
	maxLines: number,
	options: { tail?: boolean } = {},
): { rows: string[]; omitted: number } {
	const all = text.replace(/\r/g, "").replace(/\n+$/, "").split("\n");
	if (all.length === 1 && all[0] === "") return { rows: [], omitted: 0 };
	const limit = Math.max(0, Math.floor(maxLines));
	if (all.length <= limit) return { rows: all, omitted: 0 };
	const rows = options.tail ? all.slice(all.length - limit) : all.slice(0, limit);
	return { rows, omitted: all.length - rows.length };
}

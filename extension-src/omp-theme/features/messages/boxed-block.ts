// Boxed message-block shell (skill/compaction/branch/custom/MCP blocks).
// Returns only border/content lines with foreground styling; the parent Box
// applies the customMessageBg background (the native components already set
// that bgFn).

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme } from "../../shared/box.js";
import {
	boxBlankLine,
	boxBorder,
	boxInnerWidth,
	boxLabeledBorder,
	boxLine,
	boxWidth,
	dropOmittedLines,
	formatToolName,
	isInlineChrome,
} from "../../shared/box.js";
import { inlineContentWidth, inlineGlyphs, inlineGutterLines } from "../../shared/inline.js";
import { safeTruncateToWidth } from "../../shared/render-budget.js";

export type MessageBlockOptions = {
	kind: string;
	title?: string;
	right?: string;
	body: (contentWidth: number) => string[];
	hasDivider?: boolean | "auto";
	icon?: string;
	cache?: boolean;
};

function formatMessageBlockTitle(theme: BoxTheme, kind: string, title?: string, icon = "➔"): string {
	const rawTitle = title ? `${icon} ${kind} · ${title}` : `${icon} ${kind}`;
	const coloredTitle = theme.fg("accent", rawTitle);
	return typeof theme?.bold === "function" ? theme.bold(coloredTitle) : coloredTitle;
}

/**
 * Render a boxed message block.
 *
 * The title is embedded in the rounded top border, the body sits between
 * blank padding rows, and the expand hint (when present) is embedded at the
 * right end of the bottom border — no inset dividers.
 *
 * Returns only border/content lines with foreground styling. Background is
 * applied by the parent Box (all patched components extend Box with a
 * customMessageBg bgFn), so this helper must NOT apply background itself —
 * that would create a double-background conflict.
 */
export function renderBoxedMessageBlock(theme: BoxTheme, options: MessageBlockOptions): Component {
	if (isInlineChrome()) return renderInlineMessageBlock(theme, options);
	const { kind, title, right, body, icon = "➔", cache: shouldCache = true } = options;
	let cache: { width: number; lines: string[] } | null = null;

	return {
		invalidate() {
			cache = null;
		},
		render(width: number): string[] {
			if (shouldCache && cache?.width === width) return cache.lines;

			const renderedWidth = boxWidth(width);
			const contentWidth = boxInnerWidth(renderedWidth);
			const titleLine = formatMessageBlockTitle(theme, kind, title, icon);
			const bodyLines = body(contentWidth);

			const lines: string[] = [
				boxLabeledBorder(theme, "╭", "╮", titleLine, undefined, renderedWidth),
				boxBlankLine(theme, renderedWidth),
				...bodyLines.map((line) => boxLine(theme, line, renderedWidth)),
			];
			if (bodyLines.length > 0) lines.push(boxBlankLine(theme, renderedWidth));
			if (right) {
				lines.push(boxLabeledBorder(theme, "╰", "╯", "", theme.fg("dim", right), renderedWidth));
			} else {
				lines.push(boxBorder(theme, "╰", "╯", renderedWidth));
			}

			const visible = dropOmittedLines(lines);
			if (shouldCache) cache = { width, lines: visible };
			return visible;
		},
	};
}

/**
 * Inline chrome: `● Compaction · 10K→4K` with the body under the result gutter
 * and the expand hint as its last row, the way tool blocks read.
 */
function renderInlineMessageBlock(theme: BoxTheme, options: MessageBlockOptions): Component {
	const { kind, title, right, body, cache: shouldCache = true } = options;
	let cache: { width: number; lines: string[] } | null = null;
	return {
		invalidate() {
			cache = null;
		},
		render(width: number): string[] {
			if (shouldCache && cache?.width === width) return cache.lines;
			// An extension message reads by its own type (`vcc-recall` → `Vcc Recall`),
			// not as a generic `Custom · vcc-recall`.
			const custom = kind === "Custom" && title;
			const label = custom ? formatToolName(title) : kind;
			const name = typeof theme.bold === "function" ? theme.bold(theme.fg("text", label)) : theme.fg("text", label);
			const subtitle = title && !custom ? theme.fg("dim", ` · ${title}`) : "";
			const header = `${theme.fg("accent", inlineGlyphs().marker)} ${name}${subtitle}`;
			const rows = [...body(inlineContentWidth(width)), ...(right ? [theme.fg("dim", right)] : [])];
			const lines = [safeTruncateToWidth(header, Math.max(1, width), "…"), ...inlineGutterLines(theme, rows, width)];
			if (shouldCache) cache = { width, lines };
			return lines;
		},
	};
}

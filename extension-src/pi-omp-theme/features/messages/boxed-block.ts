// Boxed message-block shell (skill/compaction/branch/custom/MCP blocks).
// Returns only border/content lines with foreground styling; the parent Box
// applies the customMessageBg background (the native components already set
// that bgFn).

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme } from "../../shared/box.js";
import { boxBlankLine, boxBorder, boxInnerWidth, boxLabeledBorder, boxLine, boxWidth, dropOmittedLines } from "../../shared/box.js";

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

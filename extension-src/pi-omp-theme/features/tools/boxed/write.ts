// Boxed write tool renderer
// (renderCall/renderResult only).
//
// The write call renders a compact preview box: the file path in the top
// border, the written content as numbered lines in the body (cat -n style),
// and the metrics footer in the bottom border. The footer lives in the shared
// renderer state — the result renderer stores it (elapsed + words), the call
// component reads it at paint time and closes the box. The preview is capped
// at the collapsed line budget with a `Ctrl+O for more` hint on the bottom
// border when truncated; expanded shows the expanded budget. Errors keep the
// plain open call box so the boxed error result never duplicates a box.

import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../shared/ansi.js";
import {
	type BoxTheme,
	boxedToolWidthKey,
	dimLine,
	getTextOutput,
	renderBoxedToolResult,
	renderCompactBoxedToolCall,
	replaceTabs,
} from "../../../shared/box.js";
import { getToolsRenderConfig } from "./session-config.js";
import {
	type BoxedToolDefinition,
	clearFooterState,
	compactCall,
	compactFooterWithState,
	displayPath,
	noteExecutionStart,
	resultFooterLines,
} from "./shared.js";

/** Right-side bottom-border hint shown when the compact preview is truncated. */
const WRITE_EXPAND_HINT = "Ctrl+O for more";

/** Partial-pass result: the compact call keeps its `◌ Running` card. */
const EMPTY_WRITE_RESULT: Component = Object.freeze({
	invalidate() {},
	render() {
		return [];
	},
});

type NumberedLine = { number: string; content: string };

/**
 * Numbered preview lines for the written content, `cat -n` style: every split
 * line keeps its number (including a trailing empty line produced by a final
 * newline), right-aligned to the widest line number.
 */
function numberedPreviewLines(content: string): NumberedLine[] {
	const normalized = replaceTabs(String(content ?? "")).replace(/\r/g, "");
	if (!normalized) return [];
	const lines = normalized.split("\n");
	const gutterWidth = Math.max(1, String(lines.length).length);
	return lines.map((line, index) => ({
		number: String(index + 1).padStart(gutterWidth),
		content: line,
	}));
}

/** One boxed preview row: dim gutter + toolOutput content. */
function formatNumberedLine(theme: BoxTheme, line: NumberedLine): string {
	return `${dimLine(`${line.number} `)}${theme.fg("toolOutput", line.content)}`;
}

/** Compact write box: path header, numbered content preview, metrics footer. */
function renderWritePreviewBox(
	theme: BoxTheme,
	detailLine: string,
	content: string,
	options: {
		state?: Record<string, unknown>;
		isError: boolean;
		isPending: boolean;
		running?: boolean;
		expanded: boolean;
	},
): Component {
	const preview = numberedPreviewLines(content);
	const config = getToolsRenderConfig();
	const budget = options.expanded ? config.maxExpandedLines : config.maxCollapsedLines;
	const truncated = preview.length > budget;

	return renderCompactBoxedToolCall(theme, "Write", detailLine, {
		...(options.state ? { state: options.state } : {}),
		isError: options.isError,
		isPending: options.isPending,
		running: Boolean(options.running),
		bodyLines: () => {
			if (preview.length === 0) return [];
			const shown = preview.slice(0, budget).map((line) => formatNumberedLine(theme, line));
			if (!truncated) return shown;
			const omitted = preview.length - budget;
			const note = options.expanded ? `… ${omitted} more lines omitted by render budget` : `… ${omitted} more lines`;
			return [...shown, theme.fg("muted", note)];
		},
		...(options.expanded || options.isPending || !truncated ? {} : { bottomRightLabel: WRITE_EXPAND_HINT }),
	});
}

export const writeTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const detail = displayPath(String(args?.path ?? args?.file_path ?? ""), context);
		const detailLine = detail;
		// On error keep the plain open box: the result renderer continues it with
		// the boxed error body, so call and result never duplicate a box.
		if (context.isError) {
			return compactCall(theme, "Write", detailLine, {
				detailKey: detail,
				context,
			});
		}
		return renderWritePreviewBox(theme, detailLine, String(args?.content ?? ""), {
			state: context.state,
			isError: Boolean(context.isError),
			isPending: Boolean(context.isPartial),
			running: Boolean(context.executionStarted),
			expanded: Boolean(context.expanded),
		});
	},
	result(result, options, theme, context) {
		clearFooterState(context);
		const output = getTextOutput(result);
		const detail = displayPath(String(context?.args?.path ?? context?.args?.file_path ?? ""), context);
		const widthKey = boxedToolWidthKey("Write", detail);

		if (context.isError) {
			return renderBoxedToolResult(theme, () => [theme.fg("error", stripAnsi(output).trim() || "Error")], {
				widthKey,
				footerLines: resultFooterLines(theme, result, context),
				isError: true,
			});
		}

		// While the result is still streaming, don't stamp a metrics footer into
		// the shared state: the compact call keeps its `◌ Running` card and only
		// closes with `elapsed · words` once the tool settles.
		if (options.isPartial) return EMPTY_WRITE_RESULT;

		// Success (compact and expanded): the preview box closes with the metrics
		// footer stored into the shared renderer state; the result adds nothing.
		return compactFooterWithState(theme, result, context);
	},
};

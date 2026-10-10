// Boxed write tool renderer
// (renderCall/renderResult only).
//
// The write call renders a compact preview box: the file path in the top
// border, the written content as numbered lines in the body (cat -n style),
// and the metrics footer in the bottom border. The footer lives in the shared
// renderer state — the result renderer stores it (elapsed + words), the call
// component reads it at paint time and closes the box. The preview is capped
// at the collapsed line budget with the configured expansion hint on the
// bottom border when truncated; expanded shows the expanded budget. Errors keep the
// plain open call box so the boxed error result never duplicates a box.

import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../shared/ansi.js";
import {
	type BoxTheme,
	dimLine,
	getTextOutput,
	isInlineChrome,
	renderBoxedToolResult,
	renderCompactBoxedToolCall,
	replaceTabs,
} from "../../../shared/box.js";
import { toolExpandHint } from "../../../shared/keybinding-hints.js";
import { inlineFileApplying, inlineFileError, inlineFileWritten, renderInlineFileCall } from "./inline-edit.js";
import { getToolsRenderConfig } from "./session-config.js";
import {
	type BoxedToolDefinition,
	clearFooterState,
	compactCall,
	compactFooterWithState,
	displayPath,
	noteBoxedCallState,
	noteBoxedResultPhase,
	noteExecutionStart,
	resultFooterLines,
} from "./shared.js";

/** Partial-pass result: the compact call keeps its `◌ Running` card. */
const EMPTY_WRITE_RESULT: Component = Object.freeze({
	invalidate() {},
	render() {
		return [];
	},
});

type NumberedLine = { number: string; content: string };

/**
 * Numbered preview lines for the written content, `cat -n` style: a final
 * newline ends the last line rather than adding an empty one, and numbers are
 * right-aligned to the widest line number.
 */
function numberedPreviewLines(content: string): NumberedLine[] {
	const normalized = replaceTabs(String(content ?? "")).replace(/\r/g, "");
	if (!normalized) return [];
	const lines = normalized.split("\n");
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
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
	const expandHint = !options.expanded && !options.isPending && truncated ? toolExpandHint() : "";

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
		...(expandHint ? { bottomRightLabel: expandHint } : {}),
	});
}

/** Inline write result: `Wrote N lines` and the numbered head of the content. */
function renderInlineWriteResult(
	theme: BoxTheme,
	result: { content?: readonly unknown[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	context: Parameters<BoxedToolDefinition["result"]>[3],
): Component {
	noteBoxedResultPhase(context, options.isPartial);
	if (options.isPartial) return inlineFileApplying(theme, "Writing", context);
	if (context.isError) return inlineFileError(theme, getTextOutput(result), context);
	const preview = numberedPreviewLines(String(context.args?.content ?? ""));
	const config = getToolsRenderConfig();
	const budget = options.expanded ? config.maxExpandedLines : config.maxCollapsedLines;
	const rows = preview.slice(0, budget).map((line) => formatNumberedLine(theme, line));
	return inlineFileWritten(theme, rows, preview.length, options.expanded, context);
}

export const writeTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const detailLine = displayPath(String(args?.path ?? args?.file_path ?? ""), context);
		if (isInlineChrome()) {
			noteBoxedCallState(context);
			return renderInlineFileCall(theme, "Write", detailLine, context);
		}
		// On error keep the plain open box: the result renderer continues it with
		// the boxed error body, so call and result never duplicate a box.
		if (context.isError) return compactCall(theme, "Write", detailLine, context);
		return renderWritePreviewBox(theme, detailLine, String(args?.content ?? ""), {
			state: context.state,
			isError: Boolean(context.isError),
			isPending: Boolean(context.isPartial),
			running: Boolean(context.executionStarted),
			expanded: Boolean(context.expanded),
		});
	},
	result(result, options, theme, context) {
		if (isInlineChrome()) return renderInlineWriteResult(theme, result, options, context);
		clearFooterState(context);
		const output = getTextOutput(result);

		if (context.isError) {
			return renderBoxedToolResult(theme, () => [theme.fg("error", stripAnsi(output).trim() || "Error")], {
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

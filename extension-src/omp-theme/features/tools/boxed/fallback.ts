// Boxed fallback for tools without a dedicated renderer.
// (component side only; no ToolExecutionComponent prototype patching).

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme, MetricResultLike } from "../../../shared/box.js";
import {
	formatBoxedRunningStatus,
	formatBoxedWords,
	formatToolName,
	formatToolOutputLine,
	formatToolParamLines,
	getTextOutput,
	renderBoxedToolCall,
	renderBoxedToolResult,
	selectRenderLines,
} from "../../../shared/box.js";
import { getStateElapsedMs, getToolsRenderConfig, isResultSeen } from "./session-config.js";
import { type BoxedToolContext, noteBoxedCallState, noteBoxedResultPhase, noteExecutionStart } from "./shared.js";

const MAX_FALLBACK_PREVIEW_LINES = 10;

export function renderFallbackCall(
	toolName: unknown,
	args: Record<string, unknown>,
	theme: BoxTheme,
	context: BoxedToolContext,
): Component {
	noteExecutionStart(context);
	noteBoxedCallState(context);
	return renderBoxedToolCall(theme, formatToolName(String(toolName ?? "Tool")), formatToolParamLines(args, theme), {
		isError: Boolean(context.isError),
		isPartial: Boolean(context.isPartial),
		isPending: Boolean(context.isPartial),
		running: Boolean(context.executionStarted),
		resultSeen: isResultSeen(context.state),
	});
}

export function renderFallbackResult(
	_toolName: unknown,
	result: MetricResultLike,
	options: { expanded: boolean; isPartial: boolean },
	theme: BoxTheme,
	context: BoxedToolContext,
): Component {
	const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
	const isError = Boolean(context.isError);
	const expanded = Boolean(options.expanded);
	const maxLines = expanded ? getToolsRenderConfig().maxExpandedLines : MAX_FALLBACK_PREVIEW_LINES;
	const output = getTextOutput(result);
	const elapsedMs = getStateElapsedMs(context.state);
	const { lines, omitted } = selectRenderLines(output, maxLines);

	if (options.isPartial) {
		// Streaming continuation into the open call box: no Response divider and
		// no metrics footer until the tool settles. The first partial pass renders
		// nothing so the pending/running call card stands alone.
		if (firstResultPass) return EMPTY_FALLBACK_RESULT;
		const hasOutput = output.trim().length > 0;
		return renderBoxedToolResult(
			theme,
			() => {
				const body = lines.map((line) => formatToolOutputLine(theme, line, "toolOutput"));
				if (!hasOutput) body.push(theme.fg("dim", "No output received yet"));
				return body;
			},
			{
				dividerLabel: "Output",
				showDivider: hasOutput,
				footerLines: [formatBoxedRunningStatus(theme, elapsedMs)],
				isPartial: true,
			},
		);
	}

	return renderBoxedToolResult(
		theme,
		() => {
			const body = lines.map((line) => formatToolOutputLine(theme, line, isError ? "error" : "toolOutput"));
			if (expanded && omitted > 0) {
				body.push(theme.fg("muted", `… ${omitted} more lines omitted by render budget`));
			}
			return body;
		},
		{
			footerLines: [formatBoxedFooterWithElapsed(theme, elapsedMs, output)],
			renderLineBudget: maxLines,
			...(expanded || omitted <= 0 ? {} : { expandHint: "Ctrl+O for more" }),
			isError,
			isPartial: Boolean(options.isPartial),
		},
	);
}

/** First-partial-pass result: the pending/running call card stands alone. */
const EMPTY_FALLBACK_RESULT: Component = Object.freeze({
	invalidate() {},
	render() {
		return [];
	},
});

function formatBoxedFooterWithElapsed(theme: BoxTheme, elapsedMs: number | undefined, output: string): string {
	const elapsed = elapsedMs === undefined ? "--" : `${(elapsedMs / 1000).toFixed(2)}s`;
	const words = output.trim() ? formatBoxedWords(output) : "";
	const parts = [theme.fg("text", elapsed)];
	if (words) parts.push(theme.fg("dim", words));
	return parts.join(theme.fg("dim", " · "));
}

// Re-exported for callers that need the tool-name label normalization.
export { formatToolName };

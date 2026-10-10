// Boxed fallback for tools without a dedicated renderer.
// (component side only; no ToolExecutionComponent prototype patching).
//
// Inline chrome renders the same calls as `● Name(args)` with a `⎿` result
// gutter; a `todos` argument list renders as a checklist under the header.

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme, MetricResultLike } from "../../../shared/box.js";
import {
	formatBoxedRunningStatus,
	formatBoxedWords,
	formatToolName,
	formatToolOutputLine,
	formatToolParamLines,
	getTextOutput,
	isInlineChrome,
	renderBoxedToolCall,
	renderBoxedToolResult,
	selectRenderLines,
} from "../../../shared/box.js";
import {
	checklistFromArgs,
	checklistRows,
	emptyInlineComponent,
	inlineArgsSummary,
	inlineBlock,
	inlineElapsed,
	inlineMeta,
	inlineMoreRow,
	inlinePreview,
	inlineRunningRow,
	inlineStatus,
} from "../../../shared/inline.js";
import { toolExpandHint } from "../../../shared/keybinding-hints.js";
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
	if (isInlineChrome()) return renderInlineFallbackCall(toolName, args, theme, context);
	return renderBoxedToolCall(theme, formatToolName(String(toolName ?? "Tool")), formatToolParamLines(args, theme), {
		isError: Boolean(context.isError),
		isPending: Boolean(context.isPartial),
		running: Boolean(context.executionStarted),
		resultSeen: () => isResultSeen(context.state),
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
	if (isInlineChrome()) return renderInlineFallbackResult(result, options, theme, context);
	const isError = Boolean(context.isError);
	const expanded = Boolean(options.expanded);
	const maxLines = expanded ? getToolsRenderConfig().maxExpandedLines : MAX_FALLBACK_PREVIEW_LINES;
	const output = getTextOutput(result);
	const elapsedMs = getStateElapsedMs(context.state);
	const { lines, omitted } = selectRenderLines(output, maxLines);
	const expandHint = !expanded && omitted > 0 ? toolExpandHint() : "";

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
			...(expandHint ? { expandHint } : {}),
			isError,
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

// ── Inline presentation ──────────────────────────────────────────────────────

function renderInlineFallbackCall(
	toolName: unknown,
	args: Record<string, unknown>,
	theme: BoxTheme,
	context: BoxedToolContext,
): Component {
	const name = formatToolName(String(toolName ?? "Tool"));
	const status = inlineStatus(context);
	const checklist = checklistFromArgs(args);
	if (checklist) return inlineBlock(theme, { status, name, args: "" }, () => checklistRows(theme, checklist));
	// Until a result renderer takes over, the call carries the running row. The
	// check runs at paint time: Pi builds the result renderer after this one.
	return inlineBlock(theme, { status, name, args: inlineArgsSummary(args) }, () =>
		context.isPartial && context.executionStarted && !isResultSeen(context.state)
			? [inlineRunningRow(theme, getStateElapsedMs(context.state))]
			: [],
	);
}

function renderInlineFallbackResult(
	result: MetricResultLike,
	options: { expanded: boolean; isPartial: boolean },
	theme: BoxTheme,
	context: BoxedToolContext,
): Component {
	const isError = Boolean(context.isError);
	const output = getTextOutput(result);
	const elapsedMs = getStateElapsedMs(context.state);
	const checklist = checklistFromArgs(context.args);
	// Updates and reads carry no list in their arguments; tools that return the
	// resulting list in details (pi-todo's todo_update/todo_read) show it here.
	const resultChecklist = checklist ? undefined : checklistFromArgs(result.details);
	if (resultChecklist && !isError && !options.isPartial) {
		// A todo update is bookkeeping: the list is the whole story, no timing row.
		return inlineBlock(theme, undefined, () => checklistRows(theme, resultChecklist));
	}
	if (checklist && !isError) {
		// The checklist under the header is the record; a settled todo update adds
		// nothing, a running one only its running row.
		return options.isPartial
			? inlineBlock(theme, undefined, () => [inlineRunningRow(theme, elapsedMs)], { continues: true })
			: emptyInlineComponent();
	}
	const config = getToolsRenderConfig();
	if (options.isPartial) {
		const { rows } = inlinePreview(output, config.maxCollapsedLines, { tail: true });
		return inlineBlock(theme, undefined, () => [
			...rows.map((row) => formatToolOutputLine(theme, row, "toolOutput")),
			inlineRunningRow(theme, elapsedMs),
		]);
	}
	const expanded = Boolean(options.expanded);
	const { rows, omitted } = inlinePreview(output, expanded ? config.maxExpandedLines : config.maxCollapsedLines);
	return inlineBlock(theme, undefined, () => {
		const body = rows.map((row) => formatToolOutputLine(theme, row, isError ? "error" : "toolOutput"));
		if (body.length === 0) body.push(theme.fg(isError ? "error" : "dim", isError ? "Failed" : "(No output)"));
		if (omitted > 0) body.push(inlineMoreRow(theme, omitted, expanded));
		body.push(
			inlineMeta(theme, [
				isError ? theme.fg("error", "✘ Error") : undefined,
				inlineElapsed(elapsedMs),
				output.trim() ? formatBoxedWords(output) : undefined,
			]),
		);
		return body;
	});
}

// Re-exported for callers that need the tool-name label normalization.
export { formatToolName };

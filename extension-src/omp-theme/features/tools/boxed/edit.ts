// Boxed edit tool renderer
// (renderCall/renderResult only; no edit-core re-registration).

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../shared/ansi.js";
import {
	type BoxTheme,
	formatBoxedRunningStatus,
	getTextOutput,
	isInlineChrome,
	renderBoxedToolCall,
	renderBoxedToolResult,
} from "../../../shared/box.js";
import { formatElapsedMs, getElapsedMs } from "../../../shared/elapsed.js";
import { toolExpandHint } from "../../../shared/keybinding-hints.js";
import {
	AdaptiveDiffComponent,
	buildSplitRows,
	countDiffStats,
	extractEditedPath,
	firstText,
} from "../../../shared/split-diff.js";
import {
	inlineFileApplying,
	inlineFileDiff,
	inlineFileError,
	inlineFilePlain,
	renderInlineFileCall,
} from "./inline-edit.js";
import { isResultSeen } from "./session-config.js";
import {
	type BoxedToolContext,
	type BoxedToolDefinition,
	displayPath,
	noteBoxedCallState,
	noteBoxedResultPhase,
	noteExecutionStart,
	resultFooterLines,
	stateElapsedMs,
} from "./shared.js";

const MAX_HIGHLIGHT_DIFF_CHARS = 12000;
const MAX_HIGHLIGHT_DIFF_ROWS = 120;
/** Diff rows painted collapsed and expanded. */
const COLLAPSED_DIFF_ROWS = 36;
const EXPANDED_DIFF_ROWS = 160;

/** First-partial-pass result: the pending/running call card stands alone. */
const EMPTY_EDIT_RESULT: Component = Object.freeze({
	invalidate() {},
	render() {
		return [];
	},
});

type EditResultDetails = { diff?: string; path?: string } | undefined;

/** `Diff · +3 -0` divider label. */
/** Edit footer: `1 file · +3 -0`, prefixed with elapsed time when known. */
function editDiffFooter(
	theme: BoxTheme,
	result: { content?: readonly unknown[]; details?: unknown },
	context: BoxedToolContext,
	stats: { additions: number; removals: number },
): string {
	const elapsedMs = getElapsedMs(result) ?? stateElapsedMs(context);
	const parts: string[] = [];
	if (elapsedMs !== undefined) parts.push(theme.fg("text", formatElapsedMs(elapsedMs)));
	const plus = stats.additions > 0 ? theme.fg("toolDiffAdded", `+${stats.additions}`) : theme.fg("dim", "+0");
	const minus = stats.removals > 0 ? theme.fg("toolDiffRemoved", `-${stats.removals}`) : theme.fg("dim", "-0");
	parts.push(theme.fg("dim", "1 file"), `${plus} ${minus}`);
	return parts.join(theme.fg("dim", " · "));
}

export const editTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		noteBoxedCallState(context);
		const detail = displayPath(String(args?.path ?? args?.file_path ?? ""), context);
		if (isInlineChrome()) return renderInlineFileCall(theme, "Edit", detail, context);
		return renderBoxedToolCall(theme, "Edit", [], {
			headerDetail: detail,
			isError: Boolean(context.isError),
			isPending: Boolean(context.isPartial),
			running: Boolean(context.executionStarted),
			resultSeen: () => isResultSeen(context.state),
		});
	},
	result(result, options, theme, context) {
		// Handle partial/streaming state: continue the open call box with the
		// applying hint (no Response divider until the tool settles).
		if (options.isPartial) {
			const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
			if (isInlineChrome()) return inlineFileApplying(theme, "Applying edit", context);
			if (firstResultPass) return EMPTY_EDIT_RESULT;
			return renderBoxedToolResult(theme, () => [`${theme.fg("dim", "↳")} ${theme.fg("muted", "Applying edit...")}`], {
				showDivider: false,
				footerLines: [formatBoxedRunningStatus(theme, stateElapsedMs(context))],
			});
		}

		// Handle errors
		if (context.isError) {
			const output = getTextOutput(result);
			if (isInlineChrome()) return inlineFileError(theme, output, context);
			return renderBoxedToolResult(theme, () => [theme.fg("error", stripAnsi(output).trim() || "Error")], {
				footerLines: resultFooterLines(theme, result, context),
				isError: true,
			});
		}

		// Extract diff from result details
		const details = result.details as EditResultDetails;
		const diff = details?.diff as string | undefined;

		if (!diff) {
			const output = stripAnsi(getTextOutput(result)).trim();
			if (isInlineChrome()) return inlineFilePlain(theme, output || "Edit applied", context);
			const fallback = `↳ ${output || "Edit applied"}`;
			return renderBoxedToolResult(theme, () => [theme.fg("dim", fallback)], {
				footerLines: resultFooterLines(theme, result, context),
			});
		}

		// Resolve language for syntax highlighting
		const message = firstText(result.content as Array<{ type: string; text?: string }>);
		const argPath = String(context?.args?.path ?? context?.args?.file_path ?? "");
		const sourcePath = details?.path ?? (argPath || extractEditedPath(message));
		const language = sourcePath ? getLanguageFromPath(sourcePath) : undefined;

		// Build diff rows + adaptive layout
		const rows = buildSplitRows(diff);
		const expanded = options.expanded;
		const shouldHighlight =
			Boolean(language) && diff.length <= MAX_HIGHLIGHT_DIFF_CHARS && rows.length <= MAX_HIGHLIGHT_DIFF_ROWS;
		const stats = countDiffStats(diff);

		// Render adaptive diff (unified/split per width) with syntax colors for small outputs.
		const maxRows = expanded ? EXPANDED_DIFF_ROWS : COLLAPSED_DIFF_ROWS;
		const diffView = new AdaptiveDiffComponent(theme, rows, maxRows, shouldHighlight ? language : undefined, {
			expanded,
			expandedMaxRows: EXPANDED_DIFF_ROWS,
		});
		if (isInlineChrome()) {
			const shownPath = argPath || sourcePath;
			return inlineFileDiff(theme, diffView, stats, expanded, context, shownPath ? displayPath(shownPath, context) : undefined);
		}
		const expandHint = !expanded && diffView.hasCollapsed() ? toolExpandHint() : "";

		return renderBoxedToolResult(
			theme,
			{
				render(width: number): string[] {
					return diffView.render(width);
				},
				invalidate(): void {
					diffView.invalidate();
				},
			},
			{
				showDivider: false,
				...(expandHint ? { expandHint } : {}),
				footerLines: [editDiffFooter(theme, result, context, stats)],
			},
		);
	},
};

export type { BoxedToolContext };

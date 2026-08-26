// Boxed quick-edit / substitute-edit / target-edit renderer.

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../../shared/ansi.js";
import {
	type BoxTheme,
	formatBoxedRunningStatus,
	getTextOutput,
	renderBoxedToolCall,
	renderBoxedToolResult,
} from "../../../shared/box.js";
import { formatElapsedMs, getElapsedMs } from "../../../shared/elapsed.js";
import { AdaptiveDiffComponent, buildSplitRows, countDiffStats } from "../../../shared/split-diff.js";
import { getStateElapsedMs, isResultSeen } from "./session-config.js";
import {
	type BoxedToolContext,
	type BoxedToolDefinition,
	displayPath,
	noteBoxedCallState,
	noteBoxedResultPhase,
	noteExecutionStart,
	stateElapsedMs,
} from "./shared.js";

const MAX_HIGHLIGHT_DIFF_CHARS = 12000;
const MAX_HIGHLIGHT_DIFF_ROWS = 120;

/** First-partial-pass result: the pending/running call card stands alone. */
const EMPTY_QUICK_EDIT_RESULT = Object.freeze({
	invalidate() {},
	render() {
		return [];
	},
});

interface QuickEditToolConfig {
	toolLabel: string;
	applyingLabel: string;
	fallbackLabel: string;
}

const QUICK_EDIT_TOOLS: Readonly<Record<string, QuickEditToolConfig>> = {
	quick_edit: {
		toolLabel: "Quick Edit",
		applyingLabel: "quick-edit",
		fallbackLabel: "Quick edit applied",
	},
	substitute_edit: {
		toolLabel: "Substitute Edit",
		applyingLabel: "substitute-edit",
		fallbackLabel: "Substitute edit applied",
	},
	target_edit: {
		toolLabel: "Target Edit",
		applyingLabel: "target-edit",
		fallbackLabel: "Target edit applied",
	},
};

export function getQuickEditToolConfig(toolName: unknown): QuickEditToolConfig | undefined {
	return typeof toolName === "string" ? QUICK_EDIT_TOOLS[toolName] : undefined;
}

function extractQuickEditDiff(text: string): string | undefined {
	const lines = stripAnsi(text).replace(/\r/g, "").split("\n");
	const start = lines.indexOf("── diff ──");
	if (start < 0) return undefined;

	const diffLines: string[] = [];
	let cumulativeDelta = 0;
	let oldLine: number | undefined;
	let newLine: number | undefined;
	let chunkAdditions = 0;
	let chunkRemovals = 0;

	const finishChunk = () => {
		cumulativeDelta += chunkAdditions - chunkRemovals;
		oldLine = undefined;
		newLine = undefined;
		chunkAdditions = 0;
		chunkRemovals = 0;
	};

	for (const line of lines.slice(start + 1)) {
		if (line === "") {
			finishChunk();
			continue;
		}

		const headerMatch = line.match(/^:(\d+)(?:-\d+)?$/);
		if (headerMatch) {
			finishChunk();
			const startLine = Number.parseInt(headerMatch[1] ?? "", 10);
			oldLine = startLine;
			newLine = startLine + cumulativeDelta;
			continue;
		}

		const match = line.match(/^([+-]) (.*)$/);
		if (match) {
			const [, sign, content = ""] = match;
			let gutter = "";
			if (sign === "-" && oldLine !== undefined) gutter = String(oldLine++);
			if (sign === "+" && newLine !== undefined) gutter = String(newLine++);
			if (!gutter) continue;
			if (sign === "-") chunkRemovals++;
			if (sign === "+") chunkAdditions++;
			diffLines.push(`${sign} ${gutter} ${content}`);
			continue;
		}

		if (line === "---") break;
	}

	return diffLines.length > 0 ? diffLines.join("\n") : undefined;
}

/** Quick-edit footer: `1 file · +3 -0`, prefixed with elapsed time when known. */
function quickEditDiffFooter(
	theme: BoxTheme,
	result: { content?: readonly unknown[]; details?: unknown },
	context: BoxedToolContext,
	stats: { additions: number; removals: number },
): string {
	const elapsedMs = getElapsedMs(result) ?? getStateElapsedMs(context.state);
	const parts: string[] = [];
	if (elapsedMs !== undefined) parts.push(theme.fg("text", formatElapsedMs(elapsedMs)));
	const plus = stats.additions > 0 ? theme.fg("toolDiffAdded", `+${stats.additions}`) : theme.fg("dim", "+0");
	const minus = stats.removals > 0 ? theme.fg("toolDiffRemoved", `-${stats.removals}`) : theme.fg("dim", "-0");
	parts.push(theme.fg("dim", "1 file"), `${plus} ${minus}`);
	return parts.join(theme.fg("dim", " · "));
}

function renderQuickEditResult(
	_toolName: string,
	result: { content?: readonly unknown[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: BoxTheme,
	context: BoxedToolContext,
	config: QuickEditToolConfig,
) {
	if (options.isPartial) {
		const firstResultPass = noteBoxedResultPhase(context, options.isPartial);
		if (firstResultPass) return EMPTY_QUICK_EDIT_RESULT;
		return renderBoxedToolResult(
			theme,
			() => [`${theme.fg("dim", "↳")} ${theme.fg("muted", `Applying ${config.applyingLabel}...`)}`],
			{ showDivider: false, footerLines: [formatBoxedRunningStatus(theme, stateElapsedMs(context))], isPartial: true },
		);
	}

	const output = getTextOutput(result);
	if (context.isError) {
		return renderBoxedToolResult(theme, () => [theme.fg("error", stripAnsi(output).trim() || "Error")], {
			footerLines: [quickEditFooter(theme, context)],
			isError: true,
		});
	}

	const diff = extractQuickEditDiff(output);
	if (!diff) {
		const fallback = stripAnsi(output).trim() || config.fallbackLabel;
		return renderBoxedToolResult(theme, () => [`${theme.fg("dim", "↳")} ${theme.fg("muted", fallback)}`], {
			footerLines: [quickEditFooter(theme, context)],
		});
	}

	const rows = buildSplitRows(diff);
	const expanded = options.expanded;
	const argPath = String(context?.args?.path ?? "");
	const language = argPath ? getLanguageFromPath(argPath) : undefined;
	const shouldHighlight =
		Boolean(language) && diff.length <= MAX_HIGHLIGHT_DIFF_CHARS && rows.length <= MAX_HIGHLIGHT_DIFF_ROWS;
	const stats = countDiffStats(diff);

	const maxRows = expanded ? 160 : 36;
	const diffView = new AdaptiveDiffComponent(theme, rows, maxRows, shouldHighlight ? language : undefined);
	const expandHint = !expanded && diffView.hasCollapsed() ? "Ctrl+O more" : undefined;

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
			footerLines: [quickEditDiffFooter(theme, result, context, stats)],
		},
	);
}

function quickEditFooter(theme: BoxTheme, context: BoxedToolContext): string {
	const elapsedMs = getStateElapsedMs(context.state);
	const parts: string[] = [];
	if (elapsedMs !== undefined) parts.push(theme.fg("text", formatElapsedMs(elapsedMs)));
	parts.push(theme.fg("dim", "1 file"));
	return parts.join(theme.fg("dim", " · "));
}

export function quickEditTool(config: QuickEditToolConfig): BoxedToolDefinition {
	return {
		call(args, theme, context) {
			noteExecutionStart(context);
			noteBoxedCallState(context);
			const detail = displayPath(String(args?.path ?? ""), context);
			return renderBoxedToolCall(theme, config.toolLabel, [], {
				headerDetail: detail,
				isError: Boolean(context.isError),
				isPartial: Boolean(context.isPartial),
				isPending: Boolean(context.isPartial),
				running: Boolean(context.executionStarted),
				resultSeen: () => isResultSeen(context.state),
			});
		},
		result(result, options, theme, context) {
			return renderQuickEditResult(config.toolLabel, result, options, theme, context, config);
		},
	};
}

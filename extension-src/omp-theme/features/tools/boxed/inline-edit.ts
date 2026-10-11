// Inline presentation shared by the file-changing tools (edit, quick_edit and
// friends, write): `● Edit(path)` with the change summary opening the `⎿`
// gutter and the diff or written preview hanging under it.
//
// Parsing stays in each tool's renderer; these functions only lay out what the
// renderer already computed.

import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi, visibleWidth } from "../../../shared/ansi.js";
import type { BoxTheme } from "../../../shared/box.js";
import {
	inlineBlock,
	inlineElapsed,
	inlineMeta,
	inlineMoreRow,
	inlineRunningRow,
	inlineStatus,
} from "../../../shared/inline.js";
import { toolExpandHint } from "../../../shared/keybinding-hints.js";
import { getStateElapsedMs, getToolsRenderConfig, isResultSeen } from "./session-config.js";
import type { BoxedToolContext } from "./shared.js";

const ERROR_ROWS = 3;

function elapsedOf(context: BoxedToolContext): string | undefined {
	return inlineElapsed(getStateElapsedMs(context.state));
}

/** `● Name(path)`, carrying the running row until a result renderer takes over. */
export function renderInlineFileCall(
	theme: BoxTheme,
	name: string,
	detail: string,
	context: BoxedToolContext,
): Component {
	return inlineBlock(theme, { status: inlineStatus(context), name, args: detail }, () =>
		context.isPartial && context.executionStarted && !isResultSeen(context.state)
			? [inlineRunningRow(theme, getStateElapsedMs(context.state))]
			: [],
	);
}

/** Streaming pass: `Applying edit… 1.4s`. */
export function inlineFileApplying(theme: BoxTheme, label: string, context: BoxedToolContext): Component {
	const elapsed = getStateElapsedMs(context.state);
	const time = elapsed !== undefined && elapsed >= 1000 ? ` ${inlineElapsed(elapsed)}` : "";
	return inlineBlock(theme, undefined, () => [theme.fg("dim", `${label}…${time}`)]);
}

/** Failure: the first lines of the error, then `✘ Error · 0.2s`. */
export function inlineFileError(theme: BoxTheme, output: string, context: BoxedToolContext): Component {
	const lines = stripAnsi(output)
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim());
	const rows = lines.slice(0, ERROR_ROWS).map((line) => theme.fg("error", line));
	if (rows.length === 0) rows.push(theme.fg("error", "Error"));
	if (lines.length > ERROR_ROWS) rows.push(inlineMoreRow(theme, lines.length - ERROR_ROWS, true));
	rows.push(inlineMeta(theme, [theme.fg("error", "✘ Error"), elapsedOf(context)]));
	return inlineBlock(theme, undefined, () => rows);
}

/** A settled change without a diff: its message and elapsed on one row. */
export function inlineFilePlain(theme: BoxTheme, message: string, context: BoxedToolContext): Component {
	const text = stripAnsi(message).trim().split("\n")[0] ?? "";
	return inlineBlock(theme, undefined, () => [inlineMeta(theme, [text, elapsedOf(context)])]);
}

function countOf(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Claude Code's edit sentence: `Updated a.ts with 2 additions and 1 removal`. */
export function editSentence(path: string, stats: { additions: number; removals: number }): string {
	const parts = [
		stats.additions > 0 ? countOf(stats.additions, "addition") : "",
		stats.removals > 0 ? countOf(stats.removals, "removal") : "",
	].filter(Boolean);
	return parts.length > 0 ? `Updated ${path} with ${parts.join(" and ")}` : `Updated ${path}`;
}

/**
 * `+2 −1 · 2.2s` above the diff rows; a hint when rows were left out. With
 * `tools.editSummary` the edit sentence opens the gutter above that row.
 */
export function inlineFileDiff(
	theme: BoxTheme,
	diffView: Component & { hasCollapsed?(): boolean },
	stats: { additions: number; removals: number },
	expanded: boolean,
	context: BoxedToolContext,
	path?: string,
): Component {
	const plus = theme.fg(stats.additions > 0 ? "toolDiffAdded" : "dim", `+${stats.additions}`);
	const minus = theme.fg(stats.removals > 0 ? "toolDiffRemoved" : "dim", `−${stats.removals}`);
	const summary = inlineMeta(theme, [`${plus} ${minus}`, elapsedOf(context)]);
	const sentence = path && getToolsRenderConfig().editSummary ? editSentence(path, stats) : "";
	const block = inlineBlock(theme, undefined, (contentWidth) => {
		// Too narrow for the counts: the row below carries them, so the sentence keeps the path.
		const opener = visibleWidth(sentence) <= contentWidth ? sentence : `Updated ${path}`;
		const rows = [...(sentence ? [theme.fg("dim", opener)] : []), summary, ...diffView.render(contentWidth)];
		const hint = !expanded && diffView.hasCollapsed?.() ? toolExpandHint() : "";
		if (hint) rows.push(theme.fg("dim", `… ${hint}`));
		return rows;
	});
	return {
		invalidate() {
			diffView.invalidate();
			block.invalidate();
		},
		render: (width: number) => block.render(width),
	};
}

/**
 * Settled write: `Wrote 3 lines · 0.2s` (`Wrote 3 lines to a.ts · 0.2s` with
 * `tools.editSummary`, when the row has room for it), then the numbered head of
 * what was written within the line budget.
 */
export function inlineFileWritten(
	theme: BoxTheme,
	previewRows: readonly string[],
	totalLines: number,
	expanded: boolean,
	context: BoxedToolContext,
	path?: string,
): Component {
	const wrote = `Wrote ${countOf(totalLines, "line")}`;
	const plain = inlineMeta(theme, [wrote, elapsedOf(context)]);
	const named = path && getToolsRenderConfig().editSummary ? inlineMeta(theme, [`${wrote} to ${path}`, elapsedOf(context)]) : plain;
	const omitted = totalLines - previewRows.length;
	const more = omitted > 0 ? [inlineMoreRow(theme, omitted, expanded)] : [];
	// The path only adds to the row; where it would push the run time off, it is left out.
	return inlineBlock(theme, undefined, (contentWidth) => [
		visibleWidth(named) <= contentWidth ? named : plain,
		...previewRows,
		...more,
	]);
}

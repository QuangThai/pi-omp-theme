// Inline presentation shared by the file-changing tools (edit, quick_edit and
// friends, write): `● Edit(path)` with the change summary opening the `⎿`
// gutter and the diff or written preview hanging under it.
//
// Parsing stays in each tool's renderer; these functions only lay out what the
// renderer already computed.

import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../shared/ansi.js";
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
import { getStateElapsedMs, isResultSeen } from "./session-config.js";
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

/** `+2 −1 · 2.2s` above the diff rows; a hint when rows were left out. */
export function inlineFileDiff(
	theme: BoxTheme,
	diffView: Component & { hasCollapsed?(): boolean },
	stats: { additions: number; removals: number },
	expanded: boolean,
	context: BoxedToolContext,
): Component {
	const plus = theme.fg(stats.additions > 0 ? "toolDiffAdded" : "dim", `+${stats.additions}`);
	const minus = theme.fg(stats.removals > 0 ? "toolDiffRemoved" : "dim", `−${stats.removals}`);
	const summary = inlineMeta(theme, [`${plus} ${minus}`, elapsedOf(context)]);
	const block = inlineBlock(theme, undefined, (contentWidth) => {
		const rows = [summary, ...diffView.render(contentWidth)];
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
 * Settled write: `Wrote 3 lines · 0.2s`, then the numbered head of what was
 * written within the line budget.
 */
export function inlineFileWritten(
	theme: BoxTheme,
	previewRows: readonly string[],
	totalLines: number,
	expanded: boolean,
	context: BoxedToolContext,
): Component {
	const noun = totalLines === 1 ? "line" : "lines";
	const rows = [inlineMeta(theme, [`Wrote ${totalLines} ${noun}`, elapsedOf(context)]), ...previewRows];
	const omitted = totalLines - previewRows.length;
	if (omitted > 0) rows.push(inlineMoreRow(theme, omitted, expanded));
	return inlineBlock(theme, undefined, () => rows);
}

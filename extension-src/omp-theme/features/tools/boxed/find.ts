// Boxed find tool renderer.
//
// find calls render as a boxless tree panel — a lone find shows its parsed
// output as a flat `Find: <pattern> <N> files · in <path>` tree; consecutive
// find calls group into one panel with per-member nested subtrees (see
// batch.ts). Pending/failed calls without output fall back to a path row.

import { stripAnsi } from "../../../shared/ansi.js";
import { getTextOutput, isInlineChrome, shortenPath } from "../../../shared/box.js";
import {
	type BatchToolMeta,
	EMPTY_BATCH_COMPONENT,
	emptyBatchResult,
	registerBatchCall,
	registerBatchResult,
	renderBatchAwareCall,
} from "./batch.js";
import { parseFindOutput } from "./output-tree.js";
import { recordExecutionEnded } from "./session-config.js";
import { type BoxedToolDefinition, noteExecutionStart } from "./shared.js";

const FIND_META: BatchToolMeta = Object.freeze({
	toolName: "find",
	label: "Find",
	headerLabel: "Find",
});

function pathLabel(rawPath: string): string {
	const displayPath = String(rawPath ?? ".");
	return displayPath === "." || displayPath === "" ? "current directory" : shortenPath(displayPath);
}

function queryDetail(pattern: string, rawPath: string): string {
	const path = pathLabel(rawPath);
	// Inline headers read `Find(*.ts)`: the current directory goes without saying.
	if (isInlineChrome() && path === "current directory") return pattern || ".";
	return pattern ? `${pattern} in ${path}` : path;
}

export const findTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const pattern = String(args?.pattern ?? "");
		const rawPath = String(args?.path ?? ".");
		const detail = queryDetail(pattern, rawPath);
		const { isLeader, batch } = registerBatchCall(FIND_META, detail, context, {
			pattern,
			pathLabel: pathLabel(rawPath),
		});
		if (!isLeader) return EMPTY_BATCH_COMPONENT;
		return renderBatchAwareCall(theme, batch, context.expanded);
	},
	result(result, options, _theme, context) {
		// The call card owns this tool's display, so nothing else records the end
		// of its execution; without it the turn summary counts time until collapse.
		if (!options.isPartial) recordExecutionEnded(context.state);
		const output = stripAnsi(getTextOutput(result)).trimEnd();
		const entries = context.isError ? undefined : parseFindOutput(output);
		registerBatchResult(
			FIND_META,
			{
				isPartial: Boolean(options.isPartial),
				isError: Boolean(context.isError),
				errorText: context.isError ? output || undefined : undefined,
				...(entries !== undefined ? { entries } : {}),
			},
			context,
		);
		return emptyBatchResult();
	},
};

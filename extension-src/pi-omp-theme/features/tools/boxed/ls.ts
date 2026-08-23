// Boxed ls tool renderer.
//
// ls calls render as a boxless tree panel — a lone ls shows its parsed output as
// a flat `List: <N> files · in <path>` tree; consecutive ls calls group into one
// panel with per-member nested subtrees (see batch.ts). Pending/failed calls
// without output fall back to a path row.

import { stripAnsi } from "../../../shared/ansi.js";
import { getTextOutput, shortenPath } from "../../../shared/box.js";
import {
	type BatchToolMeta,
	EMPTY_BATCH_COMPONENT,
	emptyBatchResult,
	registerBatchCall,
	registerBatchResult,
	renderBatchAwareCall,
} from "./batch.js";
import { parseLsOutput } from "./output-tree.js";
import { type BoxedToolDefinition, noteExecutionStart } from "./shared.js";

const LIST_META: BatchToolMeta = Object.freeze({
	toolName: "ls",
	label: "List",
	headerLabel: "List",
});

function displayPath(rawPath: string): string {
	const path = String(rawPath ?? ".");
	if (path === "." || path === "") return "current directory";
	return shortenPath(path);
}

export const lsTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const rawPath = String(args?.path ?? ".");
		const detail = displayPath(rawPath);
		const { isLeader, batch } = registerBatchCall(LIST_META, detail, context, { pathLabel: detail });
		if (!isLeader) return EMPTY_BATCH_COMPONENT;
		return renderBatchAwareCall(theme, batch);
	},
	result(result, options, _theme, context) {
		const output = stripAnsi(getTextOutput(result)).trimEnd();
		const entries = context.isError ? undefined : parseLsOutput(output);
		registerBatchResult(
			LIST_META,
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

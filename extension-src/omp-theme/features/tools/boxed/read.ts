// Boxed read tool renderer
// (renderCall/renderResult only; no tool re-registration).
//
// Read calls render boxless: a lone read is a single inline line
// (`➔ Read <path>`), consecutive reads group into one tree panel (see
// batch.ts).

import { stripAnsi } from "../../../shared/ansi.js";
import { getTextOutput } from "../../../shared/box.js";
import {
	type BatchToolMeta,
	EMPTY_BATCH_COMPONENT,
	emptyBatchResult,
	registerBatchCall,
	registerBatchResult,
	renderBatchAwareCall,
} from "./batch.js";
import { recordExecutionEnded } from "./session-config.js";
import { type BoxedToolDefinition, noteExecutionStart, pathRangeDetail } from "./shared.js";

const READ_META: BatchToolMeta = Object.freeze({
	toolName: "read",
	label: "Read",
});

/** Lines of file content in a read result, without Pi's trailing `[…]` notice. */
function contentLineCount(output: string): number {
	if (!output) return 0;
	const lines = output.split("\n");
	const last = lines.at(-1) ?? "";
	if (lines.length >= 2 && /^\[.*\]$/.test(last.trim()) && lines.at(-2)?.trim() === "") lines.splice(-2);
	return lines.length;
}

export const readTool: BoxedToolDefinition = {
	call(args, theme, context) {
		noteExecutionStart(context);
		const rawPath = String(args?.path ?? args?.file_path ?? "");
		// Inline headers drop `:1`: an offset of 1 without a limit is the whole file.
		const detail = pathRangeDetail(rawPath, args?.offset, args?.limit, context);
		const { isLeader, batch } = registerBatchCall(READ_META, detail, context);
		if (!isLeader) return EMPTY_BATCH_COMPONENT;
		return renderBatchAwareCall(theme, batch, context.expanded);
	},
	result(result, options, _theme, context) {
		// The call card owns this tool's display, so nothing else records the end
		// of its execution; without it the turn summary counts time until collapse.
		if (!options.isPartial) recordExecutionEnded(context.state);
		const output = stripAnsi(getTextOutput(result)).trimEnd();
		registerBatchResult(
			READ_META,
			{
				isPartial: Boolean(options.isPartial),
				isError: Boolean(context.isError),
				errorText: context.isError ? output || undefined : undefined,
				...(context.isError || options.isPartial ? {} : { lineCount: contentLineCount(output) }),
			},
			context,
		);
		return emptyBatchResult();
	},
};

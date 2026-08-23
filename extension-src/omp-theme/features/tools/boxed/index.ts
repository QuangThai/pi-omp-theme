// Boxed tool renderer dispatcher.
//
// Maps Pi tool names to their boxed call/result renderers and falls back to a
// boxed generic renderer for unknown tools. The dispatcher is invoked from the
// tool decoration owner when tools.style === "compact-box".

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme } from "../../../shared/box.js";
import { bashTool } from "./bash.js";
import { closeActiveBatch, EMPTY_BATCH_COMPONENT, isBatchableTool } from "./batch.js";
import { editTool } from "./edit.js";
import { renderFallbackCall, renderFallbackResult } from "./fallback.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { getQuickEditToolConfig, quickEditTool } from "./quick-edit.js";
import { readTool } from "./read.js";
import { getStateElapsedMs, getToolsRenderConfig } from "./session-config.js";
import type { BoxedToolContext, BoxedToolDefinition } from "./shared.js";
import {
	emptyTurnResult,
	getTurnEntry,
	isMutatingTool,
	noteTurnMemberElapsed,
	noteTurnMemberRender,
	renderTurnSummaryCall,
	type TurnState,
} from "./turn-summary.js";
import { writeTool } from "./write.js";

function quickEditToolFor(toolName: string): BoxedToolDefinition {
	const config = getQuickEditToolConfig(toolName);
	if (!config) throw new Error(`missing quick-edit config for ${toolName}`);
	return quickEditTool(config);
}

const REGISTRY: Readonly<Record<string, BoxedToolDefinition>> = {
	read: readTool,
	write: writeTool,
	edit: editTool,
	bash: bashTool,
	ls: lsTool,
	find: findTool,
	grep: grepTool,
	quick_edit: quickEditToolFor("quick_edit"),
	substitute_edit: quickEditToolFor("substitute_edit"),
	target_edit: quickEditToolFor("target_edit"),
};

export function hasBoxedRenderer(toolName: unknown): boolean {
	return typeof toolName === "string" && Object.hasOwn(REGISTRY, toolName);
}

/**
 * Turn-summary gate (ADR 0007): the member belongs to an ended turn, Pi's
 * global tool-output state is collapsed, the surface is enabled, and the block
 * itself is not an error (errors always stay visible). Mutating tools
 * (edit/write/…) are exempt unless `tools.collapseMutatingTools` is on — their
 * blocks are the record of what was done and stay visible by default.
 */
function collapsedTurnFor(toolCallId: string, expanded: boolean): TurnState | undefined {
	const config = getToolsRenderConfig();
	if (expanded || !config.collapseAfterTurn) return undefined;
	const entry = getTurnEntry(toolCallId);
	if (!entry?.turn.ended || entry.member.isError) return undefined;
	if (isMutatingTool(entry.member.toolName) && !config.collapseMutatingTools) return undefined;
	return entry.turn;
}

export function renderBoxedToolCall(
	toolName: unknown,
	args: Record<string, unknown>,
	theme: BoxTheme,
	context: BoxedToolContext,
): Component {
	// Any non-batchable tool call is a batch boundary: the next quiet call starts
	// a fresh batch instead of joining the previous one.
	if (!isBatchableTool(toolName)) closeActiveBatch();
	const turn = collapsedTurnFor(context.toolCallId, context.expanded);
	if (turn) {
		if (turn.leaderId === context.toolCallId) return renderTurnSummaryCall(theme, turn);
		// Same singleton the batch machinery uses: the decoration's hideBatchMember
		// (identity-compared) removes the instance so members consume zero lines.
		return EMPTY_BATCH_COMPONENT;
	}
	// Capture the component invalidate so the turn_end path can force this block
	// to re-run the renderer selectors (pi only re-invokes them from updateDisplay).
	noteTurnMemberRender(context.toolCallId, context.invalidate);
	const tool = typeof toolName === "string" ? REGISTRY[toolName] : undefined;
	if (tool) return tool.call(args, theme, context);
	return renderFallbackCall(toolName, args, theme, context);
}

export function renderBoxedToolResult(
	toolName: unknown,
	result: { content?: readonly unknown[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: BoxTheme,
	context: BoxedToolContext,
): Component {
	const turn = collapsedTurnFor(context.toolCallId, options.expanded);
	if (turn) {
		// Freeze the member's wall-clock elapsed into the registry once the turn
		// collapsed (the value is already frozen by the renderer context state).
		if (!options.isPartial) noteTurnMemberElapsed(context.toolCallId, getStateElapsedMs(context.state));
		if (turn.leaderId === context.toolCallId) return emptyTurnResult();
		return EMPTY_BATCH_COMPONENT;
	}
	noteTurnMemberRender(context.toolCallId, context.invalidate);
	const tool = typeof toolName === "string" ? REGISTRY[toolName] : undefined;
	if (tool) return tool.result(result, options, theme, context);
	return renderFallbackResult(toolName, result, options, theme, context);
}

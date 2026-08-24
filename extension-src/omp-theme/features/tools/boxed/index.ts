// Boxed tool renderer dispatcher.
//
// Maps Pi tool names to their boxed call/result renderers and falls back to a
// boxed generic renderer for unknown tools. The dispatcher is invoked from the
// tool decoration owner when tools.style === "compact-box".

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme } from "../../../shared/box.js";
import { bashSettledResultLivesInCall, bashTool } from "./bash.js";
import { closeActiveBatch, EMPTY_BATCH_COMPONENT, isBatchableTool } from "./batch.js";
import { editTool } from "./edit.js";
import { renderFallbackCall, renderFallbackResult } from "./fallback.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { getQuickEditToolConfig, quickEditTool } from "./quick-edit.js";
import { readTool } from "./read.js";
import { noteToolRowHint, panelLines } from "./render-viewport.js";
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

const CALL_OWNED_SETTLED_RESULTS: ReadonlySet<string> = new Set(["read", "write", "ls", "find", "grep"]);

/** A settled phase may repaint only when the call component owns final output. */
export function settledResultLivesInCall(toolName: unknown, toolCallId: string): boolean {
	if (typeof toolName !== "string") return false;
	if (CALL_OWNED_SETTLED_RESULTS.has(toolName)) return true;
	return toolName === "bash" && bashSettledResultLivesInCall(toolCallId);
}

/**
 * Keep a call card's painted rows stable once they are out of reach.
 *
 * A call card is the one part of a tool block that keeps changing while the
 * tool runs without growing downward: the live elapsed in its running status,
 * and the batch/grep/semantic panels that read their registry on every pass.
 * Pi rebuilds the component on each `updateDisplay`, so the value is recomputed
 * even when no event touched this block. While the card is reachable that is
 * what makes it live; once it has scrolled above pi-tui's viewport, changing it
 * costs a screen-and-scrollback clear plus a replay of the whole transcript, so
 * the last painted lines are handed back instead.
 *
 * Result components are deliberately NOT wrapped: they grow at the bottom of
 * the block, where the tail the user is reading must keep streaming.
 */
function viewportStableCall(toolName: unknown, context: BoxedToolContext, component: Component): Component {
	// Running ticks and registry churn freeze once the call is out of reach.
	// Explicit expansion (Ctrl+O) always gets its own variant. Settlement gets a
	// new variant only when the call component owns the final content; tools with
	// a real result component keep the painted call card and update truthfully at
	// the visible tail instead of forcing a clear-and-replay above the viewport.
	return {
		invalidate() {
			component.invalidate?.();
		},
		render(width: number): string[] {
			// Pi builds call and result renderers before painting. Compute this here,
			// not when the wrapper is created, so semantic bash can consult the parsed
			// result state installed by its result renderer in the same display pass.
			const phase =
				!context.isPartial && settledResultLivesInCall(toolName, context.toolCallId) ? "settled" : "stable";
			const variant = `${phase}:${context.expanded ? "expanded" : "collapsed"}`;
			return panelLines(context.toolCallId, variant, width, () => component.render(width));
		},
	};
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
	// to re-run the renderer selectors (pi only re-invokes them from updateDisplay),
	// and the row the block lands on so that path can tell whether the rewrite
	// stays inside the viewport (render-viewport.ts).
	noteToolRowHint(context.toolCallId);
	noteTurnMemberRender(context.toolCallId, context.invalidate);
	const tool = typeof toolName === "string" ? REGISTRY[toolName] : undefined;
	const component = tool ? tool.call(args, theme, context) : renderFallbackCall(toolName, args, theme, context);
	// The batch singleton is identity-compared by the decoration (hideBatchMember);
	// wrapping it would leave a stray placeholder row per member.
	if (component === EMPTY_BATCH_COMPONENT) return component;
	return viewportStableCall(toolName, context, component);
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

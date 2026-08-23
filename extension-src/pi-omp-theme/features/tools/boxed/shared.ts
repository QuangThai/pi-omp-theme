// Shared context/view types + common helpers for the boxed tool renderers.

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme } from "../../../shared/box.js";
import {
	boxedToolWidthKey,
	clearCompactBoxedFooter,
	formatBoxedFooter,
	formatBoxedFooterFromValues,
	getTextOutput,
	renderCompactBoxedFooter,
	renderCompactBoxedToolCall,
	resolveRelativePath,
	shortenPath,
} from "../../../shared/box.js";
import {
	getStateElapsedMs,
	isResultSeen,
	markResultSeen,
	recordExecutionEnded,
	recordExecutionStarted,
	startElapsedTicker,
	stopElapsedTicker,
} from "./session-config.js";

/** Renderer context delivered by Pi's ToolExecutionComponent (getRenderContext). */
export interface BoxedToolContext {
	readonly args: Record<string, unknown>;
	readonly toolCallId: string;
	readonly invalidate: () => void;
	readonly state: Record<string, unknown>;
	readonly cwd: string;
	readonly executionStarted: boolean;
	readonly argsComplete: boolean;
	readonly isPartial: boolean;
	readonly expanded: boolean;
	readonly showImages: boolean;
	readonly isError: boolean;
	readonly lastComponent?: unknown;
}

/** Result view delivered to result renderers: { content, details }. */
export interface BoxedToolResult {
	readonly content?: readonly unknown[];
	readonly details?: unknown;
}

export type BoxedCallRenderer = (
	args: Record<string, unknown>,
	theme: BoxTheme,
	context: BoxedToolContext,
) => Component;
export type BoxedResultRenderer = (
	result: BoxedToolResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: BoxTheme,
	context: BoxedToolContext,
) => Component;

export interface BoxedToolDefinition {
	readonly call: BoxedCallRenderer;
	readonly result: BoxedResultRenderer;
}

export function pendingFlag(context: BoxedToolContext): boolean {
	return Boolean(context.isPartial);
}

/** Normalized display path: shortens HOME and resolves relative to the session cwd. */
export function displayPath(rawPath: string, context: BoxedToolContext): string {
	const path = String(rawPath ?? "");
	if (!path) return "(unknown)";
	return shortenPath(resolveRelativePath(path, context.cwd));
}

export function pathRangeDetail(rawPath: string, offset: unknown, limit: unknown, context: BoxedToolContext): string {
	const path = displayPath(rawPath, context);
	let range = "";
	if (offset !== undefined || limit !== undefined) {
		const start = offset ?? 1;
		const end = limit !== undefined ? Number(start) + Number(limit) - 1 : "";
		range = `:${start}${end ? `-${end}` : ""}`;
	}
	return path ? `${path}${range}` : "(unknown)";
}

/** Compact boxed call header for summary-style tools (read/write/ls/find/grep). */
export function compactCall(
	theme: BoxTheme,
	toolName: string,
	detailLine: string,
	options: { detailKey: string; context: BoxedToolContext },
): Component {
	return renderCompactBoxedToolCall(theme, toolName, detailLine, {
		widthKey: boxedToolWidthKey(toolName, options.detailKey),
		state: options.context.state,
		isError: Boolean(options.context.isError),
		isPartial: Boolean(options.context.isPartial),
		isPending: pendingFlag(options.context),
		running: Boolean(options.context.executionStarted),
	});
}

/** Record wall-clock start when execution begins (first render with executionStarted). */
export function noteExecutionStart(context: BoxedToolContext): void {
	recordExecutionStarted(context.state, context.executionStarted);
}

/**
 * Keep running/ended execution state in sync from a call renderer pass. While
 * the tool runs, a 1s re-render ticker keeps live elapsed labels current; once
 * the call renders in its terminal form the elapsed freezes.
 */
export function noteBoxedCallState(context: BoxedToolContext): void {
	if (!context.executionStarted) return;
	if (context.isPartial) startElapsedTicker(context.state, context.invalidate);
	else {
		recordExecutionEnded(context.state);
		stopElapsedTicker(context.state);
	}
}

/**
 * Record a result renderer pass and keep the ticker/ended state in sync.
 * Returns whether this is the first result pass for the call, so renderers can
 * render nothing while the pending/running call card stands alone.
 */
export function noteBoxedResultPhase(context: BoxedToolContext, isPartial: boolean): boolean {
	const firstResultPass = !isResultSeen(context.state);
	markResultSeen(context.state);
	if (isPartial) startElapsedTicker(context.state, context.invalidate);
	else {
		recordExecutionEnded(context.state);
		stopElapsedTicker(context.state);
	}
	return firstResultPass;
}

export function stateElapsedMs(context: BoxedToolContext): number | undefined {
	return getStateElapsedMs(context.state);
}

/** Footer parts with state-based elapsed when result.details lacks timing. */
export function boxedFooterWithState(
	theme: BoxTheme,
	result: BoxedToolResult | undefined,
	context: BoxedToolContext,
	extraParts: string[] = [],
): string {
	return formatBoxedFooterFromValues(theme, stateElapsedMs(context), getTextOutput(result), extraParts);
}

export function compactFooterWithState(
	theme: BoxTheme,
	result: BoxedToolResult,
	context: BoxedToolContext,
	options: { isError?: boolean; isPartial?: boolean } = {},
): Component {
	const elapsedMs = stateElapsedMs(context);
	return renderCompactBoxedFooter(theme, result, {
		state: context.state,
		isError: Boolean(options.isError ?? context.isError),
		isPartial: Boolean(options.isPartial ?? context.isPartial),
		...(elapsedMs === undefined ? {} : { elapsedMs }),
	});
}

export function resultFooterLines(
	theme: BoxTheme,
	result: BoxedToolResult,
	context: BoxedToolContext,
	extraParts: string[] = [],
): string[] {
	return [formatBoxedFooter(theme, result, extraParts, stateElapsedMs(context))];
}

export function clearFooterState(context: BoxedToolContext): void {
	clearCompactBoxedFooter(context.state);
}

/** Result-details truncation line count when the native tool truncated output. */
export function truncationOutputLines(result: BoxedToolResult | undefined): number | undefined {
	if (!result) return undefined;
	const details = result.details as { truncation?: { outputLines?: number } } | undefined;
	const value = details?.truncation?.outputLines;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Result-details grep match-limit reached counter. */
export function matchLimitReached(result: BoxedToolResult | undefined): number | undefined {
	if (!result) return undefined;
	const details = result.details as { matchLimitReached?: number } | undefined;
	const value = details?.matchLimitReached;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export { boxedToolWidthKey, getTextOutput, resolveRelativePath, shortenPath };

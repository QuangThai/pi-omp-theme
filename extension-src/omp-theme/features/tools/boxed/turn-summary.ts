// Turn tool summary registry (ADR 0007).
//
// When a turn completes, its finalized tool blocks collapse into a single
// summary line (`➔ Read 2 files, ran 4 shell commands · 3.1s`) rendered by the
// turn's leader (its first non-error tool call that collapses under the render
// config); every other collapsible tool item of the turn renders zero lines.
// Error results stay visible, interrupted turns never collapse, and Pi's
// global tool-output toggle (Ctrl+O) expands everything again
// (`options.expanded` is read, never written).
//
// Mutating tools (edit/write/quick_edit/substitute_edit/target_edit) are
// exempt from the summary by default (`tools.collapseMutatingTools: off`):
// their blocks are the record of what was done to the user's files, so they
// always stay visible (compact preview) even in an ended turn — the summary
// covers only read-only tools (read/ls/find/grep/bash). Turning the leaf on
// restores the full collapse.
//
// Design notes:
// - The registry is populated from **session content**, never from runtime
//   event flags: the live path registers the final assistant message +
//   toolResults at `turn_end`; the restore path rebuilds the registry from
//   `sessionManager.getEntries()` at session start / `session_tree`, so
//   scroll-back and session resume render identically.
// - A turn is "ended" only when every tool call of its message has a matching
//   tool result AND (live) turn_end fired / (restore) the message is
//   finalized (`stopReason`) or a later user/assistant message exists.
// - Elapsed per member is frozen from the renderer wall-clock state
//   (STARTED_AT/ENDED_AT) at the first post-turn result pass; the summary
//   totals the members' frozen elapsed. No render-time I/O.
// - No new Pi-core patch identity: the dispatcher (boxed/index.ts) decides
//   collapse before the per-tool renderers run, so every certified renderer
//   surface stays untouched when the turn is not collapsed.

import type { Component } from "@earendil-works/pi-tui";
import type { BoxTheme } from "../../../shared/box.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";
import { pluralForm } from "./output-tree.js";
import { resetToolRowHints, toolRowPlacement } from "./render-viewport.js";
import { getToolsRenderConfig } from "./session-config.js";

export interface TurnMemberInfo {
	readonly toolCallId: string;
	readonly toolName: string;
	/** Whether a tool result was registered for this call (run completeness). */
	readonly hasResult: boolean;
	isError: boolean;
	/** Frozen wall-clock elapsed (ms), recorded from the renderer context state. */
	elapsedMs?: number;
}

export interface TurnState {
	/**
	 * First non-error member that collapses under the current render config
	 * (mutating members are skipped unless `tools.collapseMutatingTools` is
	 * on); renders the summary line. Empty when every member errored or when
	 * the turn's members are all mutating with the exemption active (such a
	 * turn collapses nothing).
	 */
	leaderId: string;
	ended: boolean;
	members: readonly TurnMemberInfo[];
}

/**
 * Tools that change the user's files. Their blocks are the record of what was
 * done — they stay visible after the turn and are excluded from the summary
 * unless `tools.collapseMutatingTools` is on. bash is deliberately NOT here:
 * read-only and mutating commands are indistinguishable without parsing the
 * command text.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "quick_edit", "substitute_edit", "target_edit"]);

/** Whether the tool changes the user's files (exempt from turn collapse). */
export function isMutatingTool(toolName: string): boolean {
	return MUTATING_TOOLS.has(toolName);
}

/** Whether the summary should also cover mutating tools (render config). */
function mutatingCollapses(): boolean {
	return getToolsRenderConfig().collapseMutatingTools;
}

interface TurnEntry {
	readonly turn: TurnState;
	readonly member: TurnMemberInfo;
}

const memberByCallId = new Map<string, TurnEntry>();

/** Per-member component invalidate callbacks captured during render passes. */
const invalidateByCallId = new Map<string, () => void>();

/** Reset all turn state (session start/shutdown). */
export function resetTurnRegistry(): void {
	memberByCallId.clear();
	invalidateByCallId.clear();
	resetToolRowHints();
}

interface ToolCallLike {
	readonly type?: unknown;
	readonly id?: unknown;
	readonly name?: unknown;
}

function toolCallsOf(message: unknown): ToolCallLike[] {
	if (!message || typeof message !== "object") return [];
	const content = (message as { readonly content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const calls: ToolCallLike[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as ToolCallLike;
		if (candidate.type === "toolCall") calls.push(candidate);
	}
	return calls;
}

function registerTurn(
	calls: readonly ToolCallLike[],
	isErrorById: ReadonlyMap<string, boolean>,
	ended: boolean,
): TurnState | undefined {
	if (calls.length === 0) return undefined;
	const complete = calls.every((call) => typeof call.id === "string" && isErrorById.has(call.id));
	const members: TurnMemberInfo[] = calls.map((call) => {
		const toolCallId = String(call.id ?? "");
		return {
			toolCallId,
			toolName: typeof call.name === "string" ? call.name : "tool",
			hasResult: isErrorById.has(toolCallId),
			isError: isErrorById.get(toolCallId) === true,
		};
	});
	const leader = members.find((member) => !member.isError && (!isMutatingTool(member.toolName) || mutatingCollapses()));
	const turn: TurnState = {
		leaderId: leader?.toolCallId ?? "",
		ended: ended && complete,
		members: Object.freeze(members),
	};
	for (const member of members) memberByCallId.set(member.toolCallId, { turn, member });
	return turn;
}

export interface TurnResultLike {
	readonly toolCallId: string;
	readonly isError?: boolean;
}

/**
 * One summary group = one agent run (user request → `agent_end`). Pi emits
 * `turn_end` per assistant message, so tool batches of the same request are
 * appended to the same run and collapse into ONE summary line at `agent_end`.
 */
let currentRun: TurnState | undefined;

/** Live path: start a fresh run group (`agent_start`). */
export function beginAgentRun(): void {
	currentRun = undefined;
}

/**
 * Live path: append the finalized assistant message's tool calls and results
 * to the current run (`turn_end` event). The run stays expanded until
 * `finishAgentRun`; a batch interrupted mid-tool never collapses.
 */
export function registerTurnFromMessage(message: unknown, toolResults: readonly TurnResultLike[]): void {
	const calls = toolCallsOf(message);
	if (calls.length === 0) return;
	const isErrorById = new Map<string, boolean>();
	for (const result of toolResults) {
		if (typeof result?.toolCallId !== "string") continue;
		isErrorById.set(result.toolCallId, result.isError === true);
	}
	const newMembers: TurnMemberInfo[] = calls.map((call) => {
		const toolCallId = String(call.id ?? "");
		return {
			toolCallId,
			toolName: typeof call.name === "string" ? call.name : "tool",
			hasResult: isErrorById.has(toolCallId),
			isError: isErrorById.get(toolCallId) === true,
		};
	});
	const leader = newMembers.find(
		(member) => !member.isError && (!isMutatingTool(member.toolName) || mutatingCollapses()),
	);
	if (!currentRun) {
		currentRun = {
			leaderId: leader?.toolCallId ?? "",
			ended: false,
			members: Object.freeze(newMembers),
		};
	} else {
		if (currentRun.leaderId === "" && leader) currentRun.leaderId = leader.toolCallId;
		currentRun.members = Object.freeze([...currentRun.members, ...newMembers]);
	}
	for (const member of newMembers) memberByCallId.set(member.toolCallId, { turn: currentRun, member });
}

/**
 * Live path: finalize the current run (`agent_end`). Returns the run so the
 * caller can invalidate its blocks; undefined when the run had no tool calls
 * or is interrupted (a call without a result stays expanded).
 */
export function finishAgentRun(): TurnState | undefined {
	const run = currentRun;
	currentRun = undefined;
	if (!run) return undefined;
	// A member without a result means the run was interrupted before every call
	// settled; such a run never collapses.
	if (run.members.every((member) => member.hasResult)) run.ended = true;
	return run.ended ? run : undefined;
}

interface TurnEntryLike {
	readonly type?: unknown;
	readonly message?: {
		readonly role?: unknown;
		readonly content?: unknown;
		readonly stopReason?: unknown;
		readonly toolCallId?: unknown;
		readonly isError?: unknown;
	};
}

/**
 * Restore path: rebuild the registry from session entries (session start /
 * `session_tree`). Consecutive assistant messages between user messages form
 * one run; a run is ended when every tool call has a result AND a later user
 * message exists (historical) or its last assistant message is finalized
 * (`stopReason`). The currently streaming run stays expanded.
 */
export function rebuildTurnRegistryFromEntries(entries: readonly TurnEntryLike[] | undefined): void {
	memberByCallId.clear();
	if (!Array.isArray(entries)) return;
	const isErrorById = new Map<string, boolean>();
	const resultById = new Set<string>();
	const runs: Array<{
		calls: ToolCallLike[];
		lastStopReason: string | undefined;
		followedByUser: boolean;
	}> = [];
	let current: (typeof runs)[number] | undefined;
	const closeRun = () => {
		if (current && current.calls.length > 0) runs.push(current);
		current = undefined;
	};
	entries.forEach((entry) => {
		if (entry?.type !== "message") return;
		const message = entry.message;
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			resultById.add(message.toolCallId);
			isErrorById.set(message.toolCallId, message.isError === true);
		} else if (message?.role === "assistant") {
			if (!current) current = { calls: [], lastStopReason: undefined, followedByUser: false };
			const calls = toolCallsOf(message);
			current.calls.push(...calls);
			if (typeof message.stopReason === "string" && message.stopReason !== "")
				current.lastStopReason = message.stopReason;
		} else if (message?.role === "user") {
			if (current) {
				current.followedByUser = true;
				closeRun();
			} else {
				// A user message with no preceding open run is a plain boundary.
				closeRun();
			}
		}
	});
	closeRun();
	for (const run of runs) {
		const complete = run.calls.every((call) => typeof call.id === "string" && resultById.has(call.id));
		const ended = complete && (run.followedByUser || run.lastStopReason !== undefined);
		registerTurn(run.calls, isErrorById, ended);
	}
}

/** Registry lookup for the render dispatcher. */
export function getTurnEntry(toolCallId: string): TurnEntry | undefined {
	return memberByCallId.get(toolCallId);
}

/**
 * Capture a member's component invalidate callback during a render pass. Pi
 * only re-invokes the tool renderer selectors from updateDisplay(); calling
 * the captured callback after turn_end rebuilds the block with the collapsed
 * summary. Idempotent per toolCallId (latest component wins).
 */
export function noteTurnMemberRender(toolCallId: string, invalidate: () => void): void {
	if (typeof invalidate !== "function") return;
	invalidateByCallId.set(toolCallId, invalidate);
}

/**
 * Force the just-finished turn's tool blocks to re-render (updateDisplay).
 * Components that never rendered (headless/print) have no captured callback.
 *
 * Returns whether the blocks were rewritten now. Collapsing rewrites rows that
 * are already on screen; when the run's first collapsible block has scrolled
 * above pi-tui's viewport, that rewrite can only be painted by clearing the
 * screen and scrollback and replaying the transcript — a full-screen flash
 * that also throws away the user's scroll position. Such a run is left as it
 * is: the registry already marks it ended, so its blocks collapse on their
 * next natural re-render (resize, theme change, session restore) with no
 * forced redraw.
 */
export function invalidateTurnMembers(turn: TurnState): boolean {
	if (turn.leaderId && toolRowPlacement(turn.leaderId) === "above") return false;
	for (const member of turn.members) {
		const invalidate = invalidateByCallId.get(member.toolCallId);
		if (!invalidate) continue;
		try {
			invalidate();
		} catch {
			// A detached component must not break the turn-end path.
			invalidateByCallId.delete(member.toolCallId);
		}
	}
	return true;
}

/**
 * Freeze a member's wall-clock elapsed into the registry (idempotent; the
 * value is frozen by the renderer state once the terminal result rendered).
 */
export function noteTurnMemberElapsed(toolCallId: string, elapsedMs: number | undefined): void {
	if (elapsedMs === undefined) return;
	const entry = memberByCallId.get(toolCallId);
	if (!entry || entry.member.elapsedMs !== undefined) return;
	entry.member.elapsedMs = elapsedMs;
}

/** Per-tool summary phrasing: `Read 2 files` / `ran 4 shell commands`. */
const TURN_SUMMARY_STYLE: Readonly<Record<string, { readonly verb: string; readonly unit: string }>> = Object.freeze({
	read: { verb: "Read", unit: "file" },
	bash: { verb: "ran", unit: "shell command" },
	ls: { verb: "Listed", unit: "path" },
	find: { verb: "Found", unit: "file" },
	grep: { verb: "Grepped", unit: "pattern" },
	edit: { verb: "Edited", unit: "file" },
	write: { verb: "Wrote", unit: "file" },
	quick_edit: { verb: "Edited", unit: "file" },
	substitute_edit: { verb: "Edited", unit: "file" },
	target_edit: { verb: "Edited", unit: "file" },
});

export interface TurnSummaryParts {
	/** `Read 2 files`, `ran 4 shell commands`, ... in first-use order. */
	readonly parts: readonly string[];
	readonly failedCount: number;
	/** Sum of members' frozen elapsed; undefined when nothing was recorded. */
	readonly elapsedMs: number | undefined;
}

/**
 * Aggregate a turn's collapsed members into summary parts (pure). Mutating
 * members are excluded unless `tools.collapseMutatingTools` is on — by default
 * their visible blocks are the record; the summary describes only what it
 * hides.
 */
export function turnSummaryParts(turn: TurnState): TurnSummaryParts {
	const counts = new Map<string, number>();
	const order: string[] = [];
	let failedCount = 0;
	let elapsedMs: number | undefined;
	const collapseMutating = mutatingCollapses();
	for (const member of turn.members) {
		if (member.isError) {
			failedCount++;
			continue;
		}
		if (!collapseMutating && isMutatingTool(member.toolName)) continue;
		if (member.elapsedMs !== undefined) elapsedMs = (elapsedMs ?? 0) + member.elapsedMs;
		const existing = counts.get(member.toolName);
		if (existing === undefined) {
			counts.set(member.toolName, 1);
			order.push(member.toolName);
		} else counts.set(member.toolName, existing + 1);
	}
	const parts = order.map((toolName) => {
		const count = counts.get(toolName) ?? 0;
		const style = TURN_SUMMARY_STYLE[toolName];
		// Unknown tools (extension tools like TaskCreate/ask_user_question) use a
		// neutral phrasing with the invariant tool name: `used 5 TaskCreate`.
		return style ? `${style.verb} ${count} ${pluralForm(style.unit, count)}` : `used ${count} ${toolName}`;
	});
	return { parts, failedCount, elapsedMs };
}

function formatTurnSummaryLine(theme: BoxTheme, turn: TurnState): string {
	const summary = turnSummaryParts(turn);
	// The summary is deliberately quiet: the whole line renders dim so completed
	// tool work recedes behind the assistant's answer. Only the failed marker
	// stays error-colored (errors must remain visible).
	const parts = summary.parts.join(", ");
	let line = `${theme.fg("dim", `➔ ${parts}`)}`;
	if (summary.failedCount > 0)
		line += theme.fg("error", ` · ${summary.failedCount} ${pluralForm("failure", summary.failedCount)}`);
	if (summary.elapsedMs !== undefined) line += theme.fg("dim", ` · ${(summary.elapsedMs / 1000).toFixed(2)}s`);
	return line;
}

/** Leader call component: renders the live turn summary line on every pass. */
export function renderTurnSummaryCall(theme: BoxTheme, turn: TurnState): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			return [safeTruncateToWidth(formatTurnSummaryLine(theme, turn), Math.max(1, width), "…")];
		},
	};
}

/**
 * Empty result component for the turn-summary leader. The summary lives in the
 * call component; the result adds nothing. Deliberately NOT the shared
 * EMPTY_BATCH_COMPONENT singleton, so the decoration's hideBatchMember
 * (identity-compared) never hides the leader.
 */
export function emptyTurnResult(): Component {
	return {
		invalidate() {},
		render() {
			return [];
		},
	};
}

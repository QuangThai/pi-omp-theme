// Consecutive quiet-tool (read/ls/find) call batching.
//
// Groups back-to-back calls of the same quiet tool inside one assistant turn
// into a single collapsible, **boxless** tree panel instead of one boxed panel
// per call. The first call of a batch becomes its leader: the leader's call
// component renders the whole panel (header + tree), reading the live batch
// state on every render pass. Subsequent members render zero lines, so they
// consume no vertical space.
//
// Design notes:
// - No caching in the batch panel: it reads the module-level registry on every
//   render, so member completions (which trigger ui.requestRender via Pi's
//   tool_execution_end handler) are picked up without cross-component
//   invalidation plumbing.
// - Batch boundaries: a new batch starts when the active batch is closed. The
//   active batch closes when a non-batchable tool call is dispatched
//   (boxed/index.ts), when a new message starts (pi/index.ts), and on session
//   reset (session-coordinator.ts). A lone `read` call renders as a single
//   inline line (`➔ Read <path>`); lone ls/find calls render a flat output
//   tree (a batch of one).
// - No surrounding box: indentation and tree glyphs (├─/└─) carry the
//   hierarchy; the header line of a batched panel is the summary
//   (` Read (N) · 0.08s`).
// - Errors stay visible: failed members are always rendered inline (even in the
//   collapsed state), with their error text indented beneath the path.
// - read members render a single path row (a lone read collapses to one inline
//   line). ls/find members render their parsed output as a file subtree (flat
//   for a lone call, nested per member when batched) — see
//   renderOutputBatchPanel. Pending/failed members without output fall back to
//   the path row.

import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../shared/ansi.js";
import { type BoxTheme, dimLine, formatToolTitlePrefix } from "../../../shared/box.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";
import {
	fileIcon,
	OUTPUT_TREE_HEAD_LIMIT,
	pluralForm,
	renderOutputTree,
	SEARCH_ICON,
	SEARCH_ICON_UNICODE,
	TREE_CHILD_INDENT,
	TREE_INDENT,
} from "./output-tree.js";
import { getToolsRenderConfig } from "./session-config.js";
import type { BoxedToolContext } from "./shared.js";

/** Quiet tools whose calls group into a single batch panel. */
export const BATCHABLE_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "ls", "find"]);

export function isBatchableTool(toolName: unknown): boolean {
	if (!getToolsRenderConfig().batchQuietCalls) return false;
	return typeof toolName === "string" && BATCHABLE_TOOL_NAMES.has(toolName);
}

export interface BatchToolMeta {
	readonly toolName: string;
	/** Human label shown in the batch header (e.g. "Read", "List", "Find"). */
	readonly label: string;
	/** Header label for output-tree panels: "Find" for find, "List" for ls. */
	readonly headerLabel?: string;
}

export type BatchMemberStatus = "pending" | "running" | "done";

export interface BatchMember {
	readonly toolCallId: string;
	detail: string;
	status: BatchMemberStatus;
	isError: boolean;
	errorText?: string;
	/** find glob pattern (header detail for output panels). */
	pattern?: string;
	/** Display path (header detail for output panels). */
	pathLabel?: string;
	/** Parsed output entries once the result arrives (ls/find). `undefined` until
	 *  the result is registered; an empty array means a successful zero-entry
	 *  result (e.g. an empty directory). */
	outputEntries?: string[];
}

export interface BatchState {
	readonly meta: BatchToolMeta;
	readonly leaderId: string;
	readonly startedAt: number;
	completedAt?: number;
	closed: boolean;
	readonly members: BatchMember[];
}

/** Tree head limit: only the first few members are listed, the rest collapse. */
const BATCH_TREE_HEAD_LIMIT = 5;
/** Per-member file subtree head limit in a batched output panel. */
const BATCH_MEMBER_FILE_HEAD_LIMIT = 4;
const BATCH_ERROR_LINES = 2;
/** Indent for tree lines below the header. */
const BATCH_TREE_INDENT = TREE_INDENT;

/** Component rendered for non-leader batch members (zero height). */
export const EMPTY_BATCH_COMPONENT: Component = Object.freeze({
	invalidate() {},
	render() {
		return [];
	},
});

let activeBatch: BatchState | undefined;
const batchByCallId = new Map<string, BatchState>();

/** Close the current batch: no new members join; existing panels keep rendering. */
export function closeActiveBatch(): void {
	if (!activeBatch) return;
	activeBatch.closed = true;
	activeBatch = undefined;
}

/** Reset all batch state (session start/shutdown). */
export function resetBatchRegistry(): void {
	activeBatch = undefined;
	batchByCallId.clear();
}

function createBatch(
	meta: BatchToolMeta,
	leaderId: string,
	detail: string,
	opts: { pattern?: string; pathLabel?: string } = {},
): BatchState {
	const batch: BatchState = {
		meta,
		leaderId,
		startedAt: performance.now(),
		closed: false,
		members: [
			{
				toolCallId: leaderId,
				detail,
				status: "pending",
				isError: false,
				...(opts.pattern ? { pattern: opts.pattern } : {}),
				...(opts.pathLabel ? { pathLabel: opts.pathLabel } : {}),
			},
		],
	};
	activeBatch = batch;
	batchByCallId.set(leaderId, batch);
	return batch;
}

/**
 * Register a call renderer invocation. Idempotent per toolCallId: re-fires
 * (updateDisplay on the same component) reuse the call's existing batch, even
 * after the batch was closed.
 */
export function registerBatchCall(
	meta: BatchToolMeta,
	detail: string,
	context: BoxedToolContext,
	opts: { pattern?: string; pathLabel?: string } = {},
): { batch: BatchState; isLeader: boolean } {
	const existing = batchByCallId.get(context.toolCallId);
	if (existing) {
		const member = existing.members.find((entry) => entry.toolCallId === context.toolCallId);
		if (member) {
			member.detail = detail;
			if (opts.pattern !== undefined) member.pattern = opts.pattern;
			if (opts.pathLabel !== undefined) member.pathLabel = opts.pathLabel;
		}
		return { batch: existing, isLeader: existing.leaderId === context.toolCallId };
	}
	const current = activeBatch;
	if (!current || current.closed || current.meta.toolName !== meta.toolName) {
		closeActiveBatch();
		return { batch: createBatch(meta, context.toolCallId, detail, opts), isLeader: true };
	}
	const member: BatchMember = {
		toolCallId: context.toolCallId,
		detail,
		status: "pending",
		isError: false,
		...(opts.pattern ? { pattern: opts.pattern } : {}),
		...(opts.pathLabel ? { pathLabel: opts.pathLabel } : {}),
	};
	current.members.push(member);
	batchByCallId.set(context.toolCallId, current);
	return { batch: current, isLeader: false };
}

export interface BatchResultData {
	readonly isPartial: boolean;
	readonly isError: boolean;
	readonly errorText: string | undefined;
	/** Parsed output entries (ls/find) stored on the member for tree rendering. */
	readonly entries?: string[];
}

/**
 * Register a result renderer invocation: updates the member's status/metadata
 * and records batch completion once every member has settled. The member's
 * display detail stays as registered by the call renderer (the result context's
 * args may be normalized differently).
 */
export function registerBatchResult(
	meta: BatchToolMeta,
	data: BatchResultData,
	context: BoxedToolContext,
): { batch: BatchState | undefined; isLeader: boolean } {
	const batch = batchByCallId.get(context.toolCallId);
	if (!batch || batch.meta.toolName !== meta.toolName) return { batch: undefined, isLeader: false };
	const member = batch.members.find((entry) => entry.toolCallId === context.toolCallId);
	if (member) {
		member.status = data.isPartial ? "running" : "done";
		member.isError = !data.isPartial && data.isError;
		if (member.isError && data.errorText !== undefined) member.errorText = data.errorText;
		else delete member.errorText;
		if (data.entries !== undefined) member.outputEntries = data.entries;
	}
	if (batch.completedAt === undefined && batch.members.every((entry) => entry.status === "done")) {
		batch.completedAt = performance.now();
	}
	return { batch, isLeader: batch.leaderId === context.toolCallId };
}

interface BatchStatus {
	readonly total: number;
	readonly done: number;
	readonly failed: number;
	readonly allDone: boolean;
	readonly elapsedMs: number | undefined;
}

function batchStatus(batch: BatchState): BatchStatus {
	let done = 0;
	let failed = 0;
	for (const member of batch.members) {
		if (member.status !== "done") continue;
		done++;
		if (member.isError) failed++;
	}
	const total = batch.members.length;
	const allDone = done === total;
	return {
		total,
		done,
		failed,
		allDone,
		elapsedMs: allDone && batch.completedAt !== undefined ? batch.completedAt - batch.startedAt : undefined,
	};
}

function formatElapsed(theme: BoxTheme, elapsedMs: number): string {
	return theme.fg("dim", ` · ${(elapsedMs / 1000).toFixed(2)}s`);
}

function bold(theme: BoxTheme, text: string): string {
	return typeof theme?.bold === "function" ? theme.bold(text) : text;
}

function isOutputTool(meta: BatchToolMeta): boolean {
	return meta.toolName === "ls" || meta.toolName === "find";
}

/** Header line: state glyph + batch label(count) + progress/elapsed (no box). */
function formatBatchHeader(theme: BoxTheme, batch: BatchState, status: BatchStatus): string {
	const label = `${batch.meta.headerLabel ?? batch.meta.label} (${status.total})`;
	if (status.failed > 0) return theme.fg("error", bold(theme, `✘ ${label} · ${status.failed} failed`));
	if (status.allDone) {
		const glyph = getToolsRenderConfig().batchOpenGlyph;
		const elapsed = status.elapsedMs === undefined ? "" : formatElapsed(theme, status.elapsedMs);
		return `${theme.fg("text", bold(theme, `${glyph} ${label}`))}${elapsed}`;
	}
	if (status.done > 0)
		return `${theme.fg("text", bold(theme, `◌ ${label}`))}${theme.fg("dim", ` · ${status.done}/${status.total}`)}`;
	return bold(theme, formatToolTitlePrefix(theme, label));
}

function memberGlyph(theme: BoxTheme, member: BatchMember, show: boolean): string {
	if (!show) return "";
	if (member.isError) return theme.fg("error", "✘");
	if (member.status === "done") return theme.fg("success", "✓");
	return theme.fg("text", "◌");
}

function renderErrorLines(theme: BoxTheme, errorText: string, width: number): string[] {
	const raw = stripAnsi(errorText)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (raw.length === 0) return [];
	const prefix = `${dimLine("  │  ")}`;
	const out = raw
		.slice(0, BATCH_ERROR_LINES)
		.map((line) => safeTruncateToWidth(`${prefix}${theme.fg("error", line)}`, Math.max(1, width), "…"));
	if (raw.length > BATCH_ERROR_LINES)
		out.push(safeTruncateToWidth(`${prefix}${theme.fg("error", "…")}`, Math.max(1, width), "…"));
	return out;
}

function renderBatchTree(theme: BoxTheme, batch: BatchState, status: BatchStatus, width: number): string[] {
	const showGlyphs = !status.allDone || status.failed > 0;
	const visible = batch.members.slice(0, BATCH_TREE_HEAD_LIMIT);
	const more = batch.members.length - visible.length;
	const lastIndex = visible.length - 1;
	const out: string[] = [];
	for (let i = 0; i < visible.length; i++) {
		const member = visible[i];
		if (!member) continue;
		const branch = i < lastIndex || more > 0 ? "├─" : "└─";
		const glyph = memberGlyph(theme, member, showGlyphs);
		// Primary color for files read successfully, error red for failures.
		const pathColor = member.isError ? "error" : member.status === "done" ? "accent" : "text";
		const line = `${BATCH_TREE_INDENT}${dimLine(branch)}${glyph ? ` ${glyph}` : ""} ${theme.fg(pathColor, member.detail)}`;
		out.push(safeTruncateToWidth(line, Math.max(1, width), "…"));
		if (member.isError && member.errorText) out.push(...renderErrorLines(theme, member.errorText, width));
	}
	if (more > 0) {
		out.push(
			safeTruncateToWidth(
				`${BATCH_TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `${more} more`)}`,
				Math.max(1, width),
				"…",
			),
		);
	}
	return out;
}

/** Header for a lone (batch-of-one) ls/find output panel: `Find: <pattern> <N> files · in <path>`. */
function formatLoneOutputHeader(theme: BoxTheme, meta: BatchToolMeta, member: BatchMember): string {
	const label = meta.headerLabel ?? meta.label;
	const count = member.outputEntries?.length ?? 0;
	const filesPart = theme.fg("accent", `${count} ${count === 1 ? "file" : "files"}`);
	const patternPart = meta.toolName === "find" && member.pattern ? `${theme.fg("text", member.pattern)} ` : "";
	const pathPart = member.pathLabel ? theme.fg("dim", ` · in ${member.pathLabel}`) : "";
	// ls/find headers carry the magnifying-glass icon in Nerd Font mode,
	// matching find/grep.
	// Searching tools get the magnifier; a directory listing gets the list glyph.
	const unicodeIcon = meta.toolName === "ls" ? "▤" : SEARCH_ICON_UNICODE;
	const icon = `${getToolsRenderConfig().nerdFonts ? SEARCH_ICON : unicodeIcon} `;
	return `${icon}${bold(theme, `${label}:`)} ${patternPart}${filesPart}${pathPart}`;
}

/** Nested file subtree for one member inside a batched (2+) output panel. */
function renderMemberSubtree(theme: BoxTheme, member: BatchMember, isLastMember: boolean, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const trunk = isLastMember ? " " : dimLine("│");
	const out: string[] = [];

	// Member header row: path + file count (or status glyph when not done).
	const entries = member.outputEntries ?? [];
	if (member.isError) {
		const line = `${BATCH_TREE_INDENT}${dimLine(isLastMember ? "└─" : "├─")} ${theme.fg("error", "✘")} ${theme.fg("error", member.pathLabel ?? member.detail)}`;
		out.push(safeTruncateToWidth(line, safeWidth, "…"));
		if (member.errorText) out.push(...renderErrorLines(theme, member.errorText, width));
		return out;
	}
	if (member.status !== "done" || member.outputEntries === undefined) {
		const glyph = member.status === "done" ? theme.fg("success", "✓") : theme.fg("text", "◌");
		const line = `${BATCH_TREE_INDENT}${dimLine(isLastMember ? "└─" : "├─")} ${glyph} ${theme.fg("text", member.pathLabel ?? member.detail)}`;
		out.push(safeTruncateToWidth(line, safeWidth, "…"));
		return out;
	}

	const countLabel = theme.fg("dim", ` · ${entries.length} ${pluralForm("file", entries.length)}`);
	const headerLine = `${BATCH_TREE_INDENT}${dimLine(isLastMember ? "└─" : "├─")} ${theme.fg("accent", member.pathLabel ?? member.detail)}${countLabel}`;
	out.push(safeTruncateToWidth(headerLine, safeWidth, "…"));

	const visible = entries.slice(0, BATCH_MEMBER_FILE_HEAD_LIMIT);
	const more = entries.length - visible.length;
	const lastIndex = visible.length - 1;
	const icons = getToolsRenderConfig().nerdFonts;
	for (let i = 0; i < visible.length; i++) {
		const entry = visible[i] ?? "";
		const label = icons && entry ? `${fileIcon(entry)} ${entry}` : entry;
		const branch = i < lastIndex || more > 0 ? "├─" : "└─";
		const line = `${BATCH_TREE_INDENT}${trunk}${TREE_CHILD_INDENT}${dimLine(branch)} ${theme.fg("toolOutput", label)}`;
		out.push(safeTruncateToWidth(line, safeWidth, "…"));
	}
	if (more > 0) {
		const line = `${BATCH_TREE_INDENT}${trunk}${TREE_CHILD_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm("file", more)}`)}`;
		out.push(safeTruncateToWidth(line, safeWidth, "…"));
	}
	return out;
}

/** ls/find output panel: lone call renders a flat tree; a batch renders nested subtrees. */
function renderOutputBatchPanel(theme: BoxTheme, batch: BatchState, status: BatchStatus, width: number): string[] {
	const safeWidth = Math.max(1, width);

	// Lone successful call with output: flat tree under a `Find:/List:` header.
	if (batch.members.length === 1) {
		const member = batch.members[0];
		if (member && member.outputEntries !== undefined && !member.isError) {
			const header = safeTruncateToWidth(formatLoneOutputHeader(theme, batch.meta, member), safeWidth, "…");
			return renderOutputTree(theme, header, member.outputEntries, safeWidth, {
				headLimit: OUTPUT_TREE_HEAD_LIMIT,
				moreUnit: "file",
				entryColor: "toolOutput",
				indent: BATCH_TREE_INDENT,
				withIcons: getToolsRenderConfig().nerdFonts,
			});
		}
		// Pending/error/empty-without-entries: fall through to the path-only panel.
	}

	// Batched (2+) or a not-yet-ready lone call: per-member rows/subtrees.
	const header = safeTruncateToWidth(formatBatchHeader(theme, batch, status), safeWidth, "…");
	const out: string[] = [header];
	const visible = batch.members.slice(0, BATCH_TREE_HEAD_LIMIT);
	const more = batch.members.length - visible.length;
	visible.forEach((member, index) => {
		const isLast = index === visible.length - 1 && more <= 0;
		out.push(...renderMemberSubtree(theme, member, isLast, safeWidth));
	});
	if (more > 0) {
		out.push(
			safeTruncateToWidth(`${BATCH_TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `${more} more`)}`, safeWidth, "…"),
		);
	}
	return out;
}

/** Lone `read` call: single inline line `➔ Read <path>` — no count, no tree. */
function isLoneRead(batch: BatchState): boolean {
	return batch.meta.toolName === "read" && batch.members.length === 1;
}

/** Lone read renders `➔ Read <path>` on one line; errors keep their error text. */
function renderLoneReadPanel(theme: BoxTheme, batch: BatchState, status: BatchStatus, width: number): string[] {
	const member = batch.members[0];
	if (!member) return [];
	const prefix = bold(theme, formatToolTitlePrefix(theme, batch.meta.label));
	const glyph = memberGlyph(theme, member, !status.allDone || status.failed > 0);
	const pathColor = member.isError ? "error" : member.status === "done" ? "accent" : "text";
	const out = [
		safeTruncateToWidth(
			`${prefix}${glyph ? ` ${glyph}` : ""} ${theme.fg(pathColor, member.detail)}`,
			Math.max(1, width),
			"…",
		),
	];
	if (member.isError && member.errorText) out.push(...renderErrorLines(theme, member.errorText, width));
	return out;
}

function renderBatchPanelLines(theme: BoxTheme, batch: BatchState, status: BatchStatus, width: number): string[] {
	// Lone read collapses to a single inline line; batched reads and lone
	// ls/find calls keep their tree panels.
	if (isLoneRead(batch)) return renderLoneReadPanel(theme, batch, status, width);
	if (isOutputTool(batch.meta) && batch.members.some((member) => member.outputEntries !== undefined)) {
		return renderOutputBatchPanel(theme, batch, status, width);
	}
	const header = safeTruncateToWidth(formatBatchHeader(theme, batch, status), Math.max(1, width), "…");
	const lines = [header];
	lines.push(...renderBatchTree(theme, batch, status, width));
	return lines;
}

/**
 * Leader call component: renders the live batch panel (header + tree) reading
 * the registry on every render pass. Members render EMPTY_BATCH_COMPONENT.
 */
export function renderBatchAwareCall(theme: BoxTheme, batch: BatchState): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			return renderBatchPanelLines(theme, batch, batchStatus(batch), width);
		},
	};
}

/**
 * Empty result component for the batch leader. The panel lives in the call
 * component; the result adds nothing. Deliberately NOT the shared member
 * singleton, so the decoration's hideBatchMember (identity-compared to
 * EMPTY_BATCH_COMPONENT) never hides the leader.
 */
export function emptyBatchResult(): Component {
	return {
		invalidate() {},
		render() {
			return [];
		},
	};
}

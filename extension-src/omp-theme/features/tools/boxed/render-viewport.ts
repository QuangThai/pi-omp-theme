// Viewport awareness for tool presentation (regular/main-screen TUI mode).
//
// The renderer facts live in shared/viewport.ts; this module maps them onto
// tool blocks: where a block landed when it first rendered, whether it is still
// reachable, and the lines it last painted while it was.
//
// Callers skip rewrites that would force pi-tui's clear-and-replay redraw and
// let the block pick up its new shape on a width redraw or session restore.
// Same-width theme/config changes deliberately leave off-screen history stale:
// changing it would require the destructive redraw this module prevents.

import {
	clearPresentationTui as clearSharedPresentationTui,
	getPresentationTui,
	notePresentationTui as noteSharedPresentationTui,
	paintedRowCount,
	type PresentationTui,
	trackedViewportTop,
} from "../../../shared/viewport.js";

export type { PresentationTui };
export { getPresentationTui };

/**
 * Rows of dock chrome (working row, editor frame, status rows, spacers) that
 * sit *below* a freshly appended tool block in the frame its hint was taken
 * from. The hint counts them, so the block's real row is lower by up to this
 * much; subtracting it keeps the "inside the viewport" answer conservative.
 */
const DOCK_ALLOWANCE_ROWS = 12;

const rowHints = new Map<string, number>();
const frozenPanels = new Map<string, { width: number; lines: string[] }>();

export function notePresentationTui(candidate: unknown): void {
	noteSharedPresentationTui(candidate);
}

export function clearPresentationTui(): void {
	clearSharedPresentationTui();
}

/**
 * Record the row a tool block is about to be painted on, taken from the frame
 * painted just before its first render pass (the block is appended after that
 * frame's content, so the frame length bounds its row from above). First pass
 * wins: later passes happen once the block is already on screen.
 */
export function noteToolRowHint(toolCallId: string): void {
	if (!toolCallId || rowHints.has(toolCallId)) return;
	const rows = paintedRowCount();
	if (rows !== undefined) rowHints.set(toolCallId, rows);
}

export function resetToolRowHints(): void {
	rowHints.clear();
	frozenPanels.clear();
}

export type ToolRowPlacement = "inside" | "above" | "unknown";

/**
 * Whether the block first painted for `toolCallId` still sits inside the
 * viewport pi-tui tracks — i.e. whether rewriting it repaints incrementally
 * ("inside") or forces the clear-and-replay path ("above"). "unknown" when
 * nothing was recorded or the renderer exposes no viewport (fullscreen mode
 * has no scrollback to lose, so it also answers "inside").
 */
export function toolRowPlacement(toolCallId: string): ToolRowPlacement {
	if (!getPresentationTui()) return "unknown";
	const viewportTop = trackedViewportTop();
	// Fullscreen (or an unreadable viewport): nothing scrolls out of reach.
	if (viewportTop === undefined) return getPresentationTui()?.mode === "fullscreen" ? "inside" : "unknown";
	const hint = rowHints.get(toolCallId);
	if (hint === undefined) return "unknown";
	return hint - DOCK_ALLOWANCE_ROWS >= viewportTop ? "inside" : "above";
}

/**
 * The lines a live panel should paint this pass.
 *
 * Panels that read a live registry (batch, grep, semantic bash) and cards that
 * carry a running elapsed are rebuilt from scratch on every `updateDisplay`, so
 * their content keeps moving for as long as the tool runs. While the block is
 * reachable that is exactly right. Once it has scrolled above the viewport the
 * only faithful choice left is the one already on screen: hand back the last
 * lines painted at this width, so the frame stays byte-identical and pi-tui
 * keeps to its incremental path.
 *
 * `variant` is what the freeze deliberately does not swallow. An explicit
 * user expansion (Ctrl+O) is worth a repaint even from out of reach. Callers
 * may also include settlement only when the call component owns final output;
 * tools with a dedicated result component keep the painted call card. A width
 * change invalidates the copy too because pi-tui already repaints the whole
 * frame on resize. Theme/config changes at the same width deliberately keep old
 * off-screen rows; repainting them would reintroduce the destructive
 * clear-and-replay this cache exists to prevent.
 */
export function panelLines(
	toolCallId: string,
	variant: string,
	width: number,
	render: () => string[],
): string[] {
	if (!toolCallId) return render();
	const key = JSON.stringify([toolCallId, variant]);
	const frozen = frozenPanels.get(key);
	if (frozen && frozen.width === width && toolRowPlacement(toolCallId) === "above") return frozen.lines;
	const lines = render();
	// Keep every session-local painted copy until the session reset. Evicting by
	// count is incorrect: a long transcript would eventually evict an active
	// off-screen panel, and its next live update would force the very full redraw
	// this cache prevents. resetToolRowHints() releases all copies at the session
	// boundary together with the renderer's own transcript state.
	if (frozen) frozenPanels.delete(key);
	frozenPanels.set(key, { width, lines });
	return lines;
}

/** Frozen panel count (diagnostics/tests). */
export function frozenPanelCount(): number {
	return frozenPanels.size;
}

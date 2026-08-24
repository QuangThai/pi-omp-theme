// Viewport awareness for tool presentation (regular/main-screen TUI mode).
//
// Pi's main-screen renderer repaints incrementally: only rows that changed are
// rewritten. The one thing it cannot do incrementally is change a row that has
// already scrolled *above* the tracked viewport — for that it clears the
// screen and the scrollback (`ESC[2J ESC[H ESC[3J`) and replays every line.
// From the user's side that is a full-screen flash, a lost scroll position and
// a wiped scrollback; repeated, it reads as continuous stutter.
//
// Tool blocks are the extension's only surface that rewrites rows after they
// were drawn (turn collapse, live elapsed labels). This module records where a
// block landed when it first rendered and answers, at rewrite time, whether it
// is still inside the viewport. Callers skip rewrites that would force the
// full redraw and let the block pick up its new shape on the next natural
// re-render (resize, theme change, session restore).
//
// Only two public-in-JavaScript fields of pi-tui's main-screen renderer are
// read (`previousLines`, `previousViewportTop`); everything is optional and a
// missing field degrades to "unknown", which callers treat as safe to rewrite —
// the behaviour the extension had before this module existed.

/** Structural view of the Pi TUI a tool component carries as `ui`. */
export interface PresentationTui {
	requestRender?: (force?: boolean) => void;
	/** "regular" (main screen + scrollback) or "fullscreen" (alternate screen). */
	mode?: unknown;
	/** Main-screen renderer: the lines of the last painted frame. */
	previousLines?: unknown;
	/** Main-screen renderer: index of the first line inside the tracked viewport. */
	previousViewportTop?: unknown;
}

/**
 * Rows of dock chrome (working row, editor frame, status rows, spacers) that
 * sit *below* a freshly appended tool block in the frame its hint was taken
 * from. The hint counts them, so the block's real row is lower by up to this
 * much; subtracting it keeps the "inside the viewport" answer conservative.
 */
const DOCK_ALLOWANCE_ROWS = 12;

let presentationTui: PresentationTui | undefined;
const rowHints = new Map<string, number>();

/** Remember the Pi TUI seen from a decorated tool component (latest wins). */
export function notePresentationTui(candidate: unknown): void {
	if (candidate && typeof candidate === "object") presentationTui = candidate as PresentationTui;
}

export function clearPresentationTui(): void {
	presentationTui = undefined;
}

export function getPresentationTui(): PresentationTui | undefined {
	return presentationTui;
}

/**
 * Record the row a tool block is about to be painted on, taken from the frame
 * painted just before its first render pass (the block is appended after that
 * frame's content, so the frame length bounds its row from above). First pass
 * wins: later passes happen once the block is already on screen.
 */
export function noteToolRowHint(toolCallId: string): void {
	if (!toolCallId || rowHints.has(toolCallId)) return;
	const lines = presentationTui?.previousLines;
	if (Array.isArray(lines)) rowHints.set(toolCallId, lines.length);
}

export function resetToolRowHints(): void {
	rowHints.clear();
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
	const tui = presentationTui;
	if (!tui) return "unknown";
	if (tui.mode === "fullscreen") return "inside";
	const hint = rowHints.get(toolCallId);
	const viewportTop = tui.previousViewportTop;
	if (hint === undefined || typeof viewportTop !== "number" || !Number.isFinite(viewportTop)) return "unknown";
	return hint - DOCK_ALLOWANCE_ROWS >= viewportTop ? "inside" : "above";
}

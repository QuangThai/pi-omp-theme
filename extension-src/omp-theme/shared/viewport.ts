// What pi-tui can still repaint incrementally.
//
// pi-tui's main-screen renderer rewrites only rows inside the viewport it
// tracks. A row that has scrolled above it can be changed in one way only:
// clear the screen and the scrollback (`ESC[2J ESC[H ESC[3J`) and replay every
// line. From the user's side that is a full-screen flash, a lost scroll
// position and a wiped scrollback — and on affected ConPTY terminals it can
// leave the dock outside the visible area until the next keypress.
//
// Every surface that rewrites rows after they were drawn — live elapsed
// labels, batch/grep panels that grow, the startup card — asks this module
// whether its rows are still reachable, and keeps what is already painted when
// they are not. Only three public-in-JavaScript renderer fields are read
// (`mode`, `previousLines`, `previousViewportTop`); missing viewport state
// degrades to "unknown", which callers treat as safe to rewrite.

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

let presentationTui: PresentationTui | undefined;

/** Remember the Pi TUI seen from a decorated tool component (latest wins). */
export function notePresentationTui(candidate: unknown): void {
	if (!candidate || typeof candidate !== "object") return;
	const tui = candidate as PresentationTui;
	// Do not let a requestRender-only facade erase a renderer that already
	// exposes viewport state. Real main/alternate-screen TUI instances expose at
	// least their mode or painted-line fields; lightweight test/headless facades
	// do not provide enough information for placement decisions.
	if (tui.mode === undefined && !Array.isArray(tui.previousLines) && typeof tui.previousViewportTop !== "number") return;
	presentationTui = tui;
}

export function clearPresentationTui(): void {
	presentationTui = undefined;
}

export function getPresentationTui(): PresentationTui | undefined {
	return presentationTui;
}

/** Rows of the last painted frame, when the renderer exposes them. */
export function paintedRowCount(): number | undefined {
	const lines = presentationTui?.previousLines;
	return Array.isArray(lines) ? lines.length : undefined;
}

/**
 * Index of the first row pi-tui still repaints incrementally.
 *
 * `undefined` means "no scrollback to lose": either nothing was recorded yet,
 * or the renderer owns the alternate screen (fullscreen mode), where every row
 * is rewritable.
 */
export function trackedViewportTop(): number | undefined {
	const tui = presentationTui;
	if (!tui || tui.mode === "fullscreen") return undefined;
	const top = tui.previousViewportTop;
	return typeof top === "number" && Number.isFinite(top) ? top : undefined;
}

/**
 * Whether row 0 has scrolled out of reach.
 *
 * The startup card is the one surface whose position needs no recorded hint:
 * it is the first thing in the transcript. Once any leading row has scrolled
 * away, a later card update may touch an unreachable row and force a
 * clear-and-replay. We conservatively freeze the whole banner at that point,
 * even if some lower rows remain visible; it is session context rather than a
 * live readout, so stability is the safer trade.
 */
export function topRowScrolledAway(): boolean {
	const top = trackedViewportTop();
	return top !== undefined && top > 0;
}

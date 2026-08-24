// Per-session render configuration for boxed tool presentation.
//
// Set once per session by the compatibility coordinator; read inside renderers.
// Kept out of the render path (no filesystem/config reads during render).

export interface ToolsRenderConfig {
	maxCollapsedLines: number;
	maxExpandedLines: number;
	dimOutput: boolean;
	showElapsed: boolean;
	/** Open-tree glyph for the done batch header (nerd `\u{F111}` / unicode `●`). */
	batchOpenGlyph: string;
	/** Nerd Font mode is active: file-type icons render in output trees. */
	nerdFonts: boolean;
	/** Collapse a completed turn's tool blocks into one summary line (ADR 0007). */
	collapseAfterTurn: boolean;
	/**
	 * Group consecutive read/ls/find calls into one panel. Grouping rewrites the
	 * leader's already-drawn block each time a member joins, which Pi can only
	 * repaint by clearing the screen and scrollback when that block has scrolled
	 * out of view.
	 */
	batchQuietCalls: boolean;
	/** Also collapse mutating tools (edit/write/…) into the summary; off keeps them visible. */
	collapseMutatingTools: boolean;
}

let sessionToolsConfig: ToolsRenderConfig = {
	maxCollapsedLines: 10,
	maxExpandedLines: 50,
	dimOutput: false,
	showElapsed: true,
	batchOpenGlyph: "●",
	nerdFonts: false,
	collapseAfterTurn: true,
	collapseMutatingTools: false,
	batchQuietCalls: true,
};

export function setToolsRenderConfig(config: Partial<ToolsRenderConfig>): void {
	sessionToolsConfig = { ...sessionToolsConfig, ...config };
}

export function getToolsRenderConfig(): ToolsRenderConfig {
	return sessionToolsConfig;
}

// Wall-clock elapsed tracking through the renderer context state (no tool
// re-registration, so result.details has no execution timing).
//
// Elapsed is computed live from the recorded start on every read, so a running
// tool keeps growing its displayed time. The value only freezes once the
// execution end is recorded (terminal result), which keeps the completed footer
// stable across later re-renders (expand toggles, terminal resizes).

const STARTED_AT_KEY = "__piOmpThemeStartedAt";
const ENDED_AT_KEY = "__piOmpThemeEndedAt";
const RESULT_SEEN_KEY = "__piOmpThemeResultSeen";
const TICKER_KEY = "__piOmpThemeElapsedTicker";

export function recordExecutionStarted(state: Record<string, unknown> | undefined, executionStarted: boolean): void {
	if (!executionStarted || !state || typeof state !== "object") return;
	if (typeof state[STARTED_AT_KEY] !== "number") state[STARTED_AT_KEY] = performance.now();
}

/** Freeze the elapsed at the first terminal render (idempotent). */
export function recordExecutionEnded(state: Record<string, unknown> | undefined): void {
	if (!state || typeof state !== "object") return;
	if (typeof state[ENDED_AT_KEY] !== "number") state[ENDED_AT_KEY] = performance.now();
}

export function getStateElapsedMs(state: Record<string, unknown> | undefined): number | undefined {
	if (!state || typeof state !== "object") return undefined;
	const started = state[STARTED_AT_KEY];
	if (typeof started !== "number") return undefined;
	const ended = state[ENDED_AT_KEY];
	if (typeof ended === "number") return Math.max(0, ended - started);
	return Math.max(0, performance.now() - started);
}

/** Whether a result renderer already produced a continuation for this call. */
export function isResultSeen(state: Record<string, unknown> | undefined): boolean {
	return Boolean(state && typeof state === "object" && state[RESULT_SEEN_KEY] === true);
}

/** Record that a result renderer ran for this call (streaming or final). */
export function markResultSeen(state: Record<string, unknown> | undefined): void {
	if (!state || typeof state !== "object") return;
	state[RESULT_SEEN_KEY] = true;
}

type TickerHandle = ReturnType<typeof setInterval>;

/** States that currently own a 1s elapsed-render interval, for session cleanup. */
const tickerStates = new Set<Record<string, unknown>>();

/**
 * While a tool is running, re-render once per second so live elapsed labels
 * tick without any output events. Idempotent per state.
 */
export function startElapsedTicker(state: Record<string, unknown> | undefined, invalidate: () => void): void {
	if (!state || typeof state !== "object") return;
	if (state[TICKER_KEY] !== undefined) return;
	state[TICKER_KEY] = setInterval(() => invalidate(), 1000) as unknown as TickerHandle;
	tickerStates.add(state);
}

/** Stop a running tool's elapsed ticker (terminal result, error, session end). */
export function stopElapsedTicker(state: Record<string, unknown> | undefined): void {
	if (!state || typeof state !== "object") return;
	const handle = state[TICKER_KEY] as TickerHandle | undefined;
	if (handle !== undefined) clearInterval(handle);
	delete state[TICKER_KEY];
	tickerStates.delete(state);
}

/**
 * Stop every elapsed ticker and freeze the elapsed of every state that still
 * had one (session start/shutdown, agent run boundaries).
 *
 * A ticker normally stops on the tool's terminal render pass. When a run is
 * interrupted, Pi drops the pending tool before that pass happens (its
 * `agent_end` clears the pending set, so a late result is never applied): the
 * component stays "partial" forever and its ticker would keep invalidating it
 * once a second for the rest of the session. Once that block scrolls out of
 * view, each tick forces pi-tui's clear-and-replay redraw — a stutter every
 * second plus a wiped scrollback. The run boundary is the reliable backstop.
 */
export function stopAllElapsedTickers(): void {
	for (const state of tickerStates) {
		const handle = state[TICKER_KEY] as TickerHandle | undefined;
		if (handle !== undefined) clearInterval(handle);
		delete state[TICKER_KEY];
		recordExecutionEnded(state);
	}
	tickerStates.clear();
}

/** Number of live elapsed tickers (diagnostics). */
export function activeElapsedTickerCount(): number {
	return tickerStates.size;
}

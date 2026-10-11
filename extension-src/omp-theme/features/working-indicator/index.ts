/**
 * Working row: the spinner and message Pi shows while the agent is running.
 *
 * Pi renders extension-supplied frames verbatim and applies no color of its own,
 * so the color is baked into each frame here. Both the spinner tick and the
 * shimmer rewrite a single line, which stays on Pi's differential render path —
 * the transcript above is untouched, so neither forces a full repaint.
 */

import { displayKeyHint } from "../../shared/keybinding-hints.js";
import { createSegmentedShimmer, type ShimmerMode, type ShimmerPalette } from "../../shared/shimmer.js";

/** omp's `status` spinner set, at its 80 ms cadence. */
const STATUS_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;
const FRAME_INTERVAL_MS = 80;

/** ASCII fallback for terminals configured without Unicode block support. */
const ASCII_FRAMES = ["|", "/", "-", "\\"] as const;

/** 30 fps: matches the shimmer's travel speed, so the band steps one cell a frame. */
const SHIMMER_INTERVAL_MS = Math.round(1000 / 30);

/** Pi's own wording, kept verbatim so only the color sweep is added. */
const WORKING_TEXT = "Working...";

/**
 * The interrupt hint Pi appends to its working message once a run is under way
 * (`interactive-mode.js`: `${defaultWorkingMessage} (${key} to interrupt)`).
 * Repainting the row every frame would otherwise drop it, leaving the bare word
 * where the whole line used to be.
 */
function interruptHint(meta: readonly string[] = []): string {
	const hint = displayKeyHint("app.interrupt", "to interrupt");
	const parts = [...meta, hint].filter(Boolean);
	return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

/** Run time as Claude Code shows it: `14s`, `2m 5s`; nothing before the first second. */
export function formatRunElapsed(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 1) return "";
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Token count as Claude Code shows it: `312`, `1.2k`, `24k`, `1.2M`. */
export function formatTokenCount(tokens: number): string {
	const count = Math.max(0, Math.round(tokens));
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (count < 999_500) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// ── Run output tokens ────────────────────────────────────────────────────────
//
// A finished message reports its real output tokens in `usage.output`; until it
// does, the text streamed so far stands in at about four characters a token.
// A provider that reports no usage keeps the estimate for its messages.

const CHARS_PER_TOKEN = 4;
let settledTokens = 0;
let streamedChars = 0;

/** Output tokens of the current run so far. */
export function runOutputTokens(): number {
	return settledTokens + Math.round(streamedChars / CHARS_PER_TOKEN);
}

/** A `message_update` event: text, thinking and tool-argument deltas count. */
export function noteStreamedDelta(event: unknown): void {
	const { type, delta } = (event ?? {}) as { type?: unknown; delta?: unknown };
	if (typeof delta !== "string") return;
	if (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") streamedChars += delta.length;
}

/** A `message_end` event: an assistant message's reported usage replaces its estimate. */
export function noteMessageEnd(message: unknown): void {
	const { role, usage } = (message ?? {}) as { role?: unknown; usage?: { output?: unknown } };
	if (role !== "assistant") return;
	const reported = usage?.output;
	settledTokens +=
		typeof reported === "number" && Number.isFinite(reported) && reported > 0
			? reported
			: Math.round(streamedChars / CHARS_PER_TOKEN);
	streamedChars = 0;
}

function resetRunTokens(): void {
	settledTokens = 0;
	streamedChars = 0;
}

export interface WorkingIndicatorHost {
	setWorkingIndicator?: (options?: { frames: string[]; intervalMs?: number }) => void;
	setWorkingMessage?: (message?: string) => void;
	// Method syntax, not a function property: Pi's own `fg` accepts only its
	// ThemeColor union, which contravariance would reject against a `string`
	// parameter. `BoxTheme` declares its `fg` the same way for the same reason.
	theme?: { fg?(color: string, text: string): string };
}

/**
 * Install the spinner. Returns whether Pi accepted it, so the caller can record
 * the surface as unavailable rather than assume it took effect.
 */
export function installWorkingIndicator(ui: WorkingIndicatorHost | undefined, ascii = false): boolean {
	if (typeof ui?.setWorkingIndicator !== "function") return false;
	const frames = (ascii ? ASCII_FRAMES : STATUS_FRAMES).map((frame) => {
		try {
			return ui.theme?.fg?.("accent", frame) ?? frame;
		} catch {
			return frame;
		}
	});
	try {
		ui.setWorkingIndicator({ frames, intervalMs: FRAME_INTERVAL_MS });
		return true;
	} catch {
		return false;
	}
}

/** Hand the spinner back to Pi. Cleanup must never throw. */
export function restoreWorkingIndicator(ui: WorkingIndicatorHost | undefined): void {
	if (typeof ui?.setWorkingIndicator !== "function") return;
	try {
		ui.setWorkingIndicator(undefined);
	} catch {
		// Best-effort restore.
	}
}

// ── Working-message shimmer ──────────────────────────────────────────────────

interface ShimmerState {
	host: WorkingIndicatorHost;
	mode: ShimmerMode;
	/** Resolved per run, not per session — see {@link buildRowRenderer}. */
	palette: () => ShimmerPalette;
	render?: (time: number) => string;
	animated: boolean;
	/** Show the run's elapsed time inside the hint (`(14s · Escape to interrupt)`). */
	elapsed: boolean;
	/** Show the run's output tokens inside the hint (`(14s · ↓ 1.2k tokens · …)`). */
	tokens: boolean;
	/** Leave the `↓` off in ASCII mode. */
	ascii: boolean;
	/** Run start (agent_start) and the hint text the current renderer was built for. */
	startedAt?: number;
	metaText?: string;
	timer?: ReturnType<typeof setInterval> | undefined;
}

/**
 * The lit row, built per run rather than per session.
 *
 * Both of its inputs are late-bound for the same reason: at session start Pi may
 * not have handed the extension a theme yet, and a palette resolved then comes
 * back empty and stays empty for the whole session — the row renders bold but
 * colourless. The interrupt hint names a keybinding and is unresolvable that
 * early for the same kind of reason. Compiling here still happens once per run,
 * not once per frame, and it picks up a theme the user switched to mid-session.
 */
function buildRowRenderer(state: ShimmerState, meta: readonly string[] = []): (time: number) => string {
	const hint = interruptHint(meta);
	const palette = state.palette();
	// The hint sits one tier below the message so it reads as an aside; the same
	// wave still passes through it, as omp lights the row.
	const hintPalette: ShimmerPalette = { low: palette.low, mid: palette.low, high: palette.mid };
	const segments = hint
		? [
				{ text: WORKING_TEXT, palette },
				{ text: hint, palette: hintPalette },
			]
		: [{ text: WORKING_TEXT, palette }];
	return createSegmentedShimmer(segments, state.mode);
}

let shimmer: ShimmerState | undefined;

/**
 * Arm the shimmer for this session. Nothing animates until
 * {@link startWorkingShimmer} runs, so an idle session carries no timer.
 *
 * The row is lit as two runs under one wave, as omp lights it: the message
 * carries the accent, the interrupt hint stays a step quieter so it reads as
 * an aside rather than as part of the status.
 */
export function configureWorkingShimmer(
	ui: WorkingIndicatorHost | undefined,
	mode: ShimmerMode,
	palette: () => ShimmerPalette,
	options: { elapsed?: boolean; tokens?: boolean; ascii?: boolean } = {},
): void {
	disposeWorkingShimmer();
	if (!ui || typeof ui.setWorkingMessage !== "function") return;
	shimmer = {
		host: ui,
		mode,
		palette,
		animated: mode !== "off",
		elapsed: options.elapsed === true,
		tokens: options.tokens === true,
		ascii: options.ascii === true,
	};
}

/** Follow a live config change; the next run picks it up. */
export function setWorkingElapsed(enabled: boolean): void {
	if (shimmer) shimmer.elapsed = enabled;
}

/** Follow a live config change; the next run picks it up. */
export function setWorkingTokens(enabled: boolean): void {
	if (shimmer) shimmer.tokens = enabled;
}

/** The hint's run details: `14s`, `↓ 1.2k tokens`. */
function runMeta(state: ShimmerState, now: number): string[] {
	const meta: string[] = [];
	if (state.elapsed) meta.push(formatRunElapsed(now - (state.startedAt ?? now)));
	const tokens = state.tokens ? runOutputTokens() : 0;
	if (tokens > 0) meta.push(`${state.ascii ? "" : "↓ "}${formatTokenCount(tokens)} tokens`);
	return meta.filter(Boolean);
}

/** Begin sweeping. Safe to call repeatedly; a second call does not stack timers. */
export function startWorkingShimmer(): void {
	resetRunTokens();
	const state = shimmer;
	if (!state || state.timer) return;
	state.startedAt = Date.now();
	state.metaText = "";
	state.render = buildRowRenderer(state);
	const paint = () => {
		try {
			const now = Date.now();
			if (state.elapsed || state.tokens) {
				// The row is recompiled only when its details change, at most once a paint.
				const meta = runMeta(state, now);
				const text = meta.join(" · ");
				if (text !== state.metaText) {
					state.metaText = text;
					state.render = buildRowRenderer(state, meta);
				}
			}
			state.host.setWorkingMessage?.(state.render?.(now) ?? WORKING_TEXT);
		} catch {
			stopWorkingShimmer();
		}
	};
	paint();
	// A static palette needs no timer unless the run details tick: one paint
	// holds the color for the whole run.
	if (!state.animated && !state.elapsed && !state.tokens) return;
	state.timer = setInterval(paint, state.animated ? SHIMMER_INTERVAL_MS : 1000);
	// Never hold the process open for a decoration.
	state.timer.unref?.();
}

/** Stop sweeping and hand the message back to Pi. */
export function stopWorkingShimmer(): void {
	const state = shimmer;
	if (!state) return;
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
	try {
		state.host.setWorkingMessage?.(undefined);
	} catch {
		// Best-effort restore.
	}
}

/** Drop the session's shimmer entirely (shutdown). */
export function disposeWorkingShimmer(): void {
	stopWorkingShimmer();
	shimmer = undefined;
}

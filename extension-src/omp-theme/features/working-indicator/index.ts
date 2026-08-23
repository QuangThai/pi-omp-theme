/**
 * Working row: the spinner and message Pi shows while the agent is running.
 *
 * Pi renders extension-supplied frames verbatim and applies no color of its own,
 * so the color is baked into each frame here. Both the spinner tick and the
 * shimmer rewrite a single line, which stays on Pi's differential render path —
 * the transcript above is untouched, so neither forces a full repaint.
 */

import { keyText } from "@earendil-works/pi-coding-agent";
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
function interruptHint(): string {
	try {
		const key = keyText("app.interrupt");
		return key ? ` (${key} to interrupt)` : "";
	} catch {
		return "";
	}
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
function buildRowRenderer(state: ShimmerState): (time: number) => string {
	const hint = interruptHint();
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
): void {
	disposeWorkingShimmer();
	if (!ui || typeof ui.setWorkingMessage !== "function") return;
	shimmer = { host: ui, mode, palette, animated: mode !== "off" };
}

/** Begin sweeping. Safe to call repeatedly; a second call does not stack timers. */
export function startWorkingShimmer(): void {
	const state = shimmer;
	if (!state || state.timer) return;
	const render = buildRowRenderer(state);
	state.render = render;
	const paint = () => {
		try {
			state.host.setWorkingMessage?.(render(Date.now()));
		} catch {
			stopWorkingShimmer();
		}
	};
	paint();
	// A static palette needs no timer: one paint holds the color for the whole run.
	if (!state.animated) return;
	state.timer = setInterval(paint, SHIMMER_INTERVAL_MS);
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

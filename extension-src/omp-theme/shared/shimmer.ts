/**
 * Sweeping highlight for the working message, ported from omp's shimmer.
 *
 * The band position advances at a fixed cells-per-second rather than dividing a
 * fixed sweep duration by the text length. That keeps the step at or below one
 * cell per frame for any message, so a long message is no steppier than a short
 * one; only the round-trip duration scales with length.
 */

/** Band travel speed, in cells per second. Keep at or below the driver's frame rate. */
const SPEED_CELLS_PER_S = 30;

const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;

const KITT_HEAD_HALF = 0.6;
const KITT_TRAIL_LEN = 7;

const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

export type ShimmerMode = "classic" | "kitt" | "off";

/** Three ANSI foreground prefixes a character cycles through as the band passes. */
export interface ShimmerPalette {
	/** Outside the band. */
	readonly low: string;
	/** Approaching the crest. */
	readonly mid: string;
	/** At the crest. */
	readonly high: string;
	/** Whether the crest is bold. */
	readonly bold?: boolean;
}

type Tier = "low" | "mid" | "high";
interface TierSeq {
	open: string;
	close: string;
}
type CompiledPalette = Record<Tier, TierSeq>;

function compile(palette: ShimmerPalette): CompiledPalette {
	const highOpen = palette.bold ? `${BOLD_OPEN}${palette.high}` : palette.high;
	return {
		low: { open: palette.low, close: palette.low ? FG_RESET : "" },
		mid: { open: palette.mid, close: palette.mid ? FG_RESET : "" },
		high: {
			open: highOpen,
			close: palette.bold ? `${BOLD_CLOSE}${palette.high ? FG_RESET : ""}` : palette.high ? FG_RESET : "",
		},
	};
}

/** Smooth cosine bump sweeping left to right, with padding either side. */
function classicIntensity(time: number, index: number, length: number): number {
	const period = length + CLASSIC_PADDING * 2;
	const pos = ((time / 1000) * SPEED_CELLS_PER_S) % period;
	const dist = Math.abs(index + CLASSIC_PADDING - pos);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

/**
 * Knight Rider scanner: one bright head ping-pongs across the text with a
 * quadratic-decay trail behind it. Nothing lights up ahead of the head.
 */
function kittIntensity(time: number, index: number, length: number): number {
	const range = length - 1;
	if (range <= 0) return 1;
	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	const delta = index - head;
	const abs = delta < 0 ? -delta : delta;
	if (abs <= KITT_HEAD_HALF) return 1;
	const behind = goingRight ? -delta : delta;
	if (behind <= KITT_HEAD_HALF) return 0;
	const t = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
	if (t >= 1) return 0;
	const f = 1 - t;
	return f * f;
}

/**
 * Index window outside which the intensity is zero. Skipping the intensity call
 * for the prefix and suffix removes most of the per-character loop: the classic
 * band spans ~12 cells of a typical message.
 */
function activeBand(mode: "classic" | "kitt", time: number, total: number): { lo: number; hi: number } {
	if (mode === "classic") {
		const period = total + CLASSIC_PADDING * 2;
		const pos = ((time / 1000) * SPEED_CELLS_PER_S) % period;
		return { lo: pos - CLASSIC_PADDING - CLASSIC_BAND_HALF_WIDTH, hi: pos - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH };
	}
	const range = total - 1;
	if (range <= 0) return { lo: 0, hi: total };
	const cycleCells = 2 * range;
	const sweep = ((time / 1000) * SPEED_CELLS_PER_S) % cycleCells;
	const goingRight = sweep < range;
	const head = goingRight ? sweep : cycleCells - sweep;
	return goingRight
		? { lo: head - KITT_HEAD_HALF - KITT_TRAIL_LEN, hi: head + KITT_HEAD_HALF }
		: { lo: head - KITT_HEAD_HALF, hi: head + KITT_HEAD_HALF + KITT_TRAIL_LEN };
}

function tierFor(intensity: number): Tier {
	if (intensity >= TIER_HIGH) return "high";
	if (intensity >= TIER_MID) return "mid";
	return "low";
}

/** Code-point count. Surrogate pairs are one position, so an emoji stays atomic. */
function countCodePoints(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) i++;
		}
		count++;
	}
	return count;
}

/**
 * Build a shimmer renderer. The palette is compiled once here so each frame only
 * emits one escape pair per run of same-tier characters, not one per character.
 */
export function createShimmer(
	palette: ShimmerPalette,
	mode: ShimmerMode,
): (text: string, time: number) => string {
	const compiled = compile(palette);
	if (mode === "off") {
		// Still paint the message in the mid tier so it matches the animated look
		// without moving.
		return (text) => (text ? `${compiled.mid.open}${text}${compiled.mid.close}` : text);
	}
	const intensityFn = mode === "kitt" ? kittIntensity : classicIntensity;

	return (text: string, time: number): string => {
		const total = countCodePoints(text);
		if (total === 0) return "";
		return sweep(text, compiled, intensityFn, time, activeBand(mode, time, total), 0, total);
	};
}

/**
 * Paint one run of text against a band that may span a longer line. `offset` is
 * where this run starts within that line and `total` the line's full length, so
 * runs lit by the same wave stay in phase with each other.
 */
function sweep(
	text: string,
	compiled: CompiledPalette,
	intensityFn: (time: number, index: number, total: number) => number,
	time: number,
	band: { lo: number; hi: number },
	offset: number,
	total: number,
): string {
	let out = "";
	let runTier: Tier | undefined;
	let runStart = 0;
	let runEnd = 0;
	let index = offset;
	let i = 0;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		let step = 1;
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) step = 2;
		}
		const tier: Tier = index < band.lo || index > band.hi ? "low" : tierFor(intensityFn(time, index, total));
		if (tier !== runTier) {
			if (runTier !== undefined && runEnd > runStart) {
				const seq = compiled[runTier];
				out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
			}
			runTier = tier;
			runStart = i;
		}
		runEnd = i + step;
		index++;
		i += step;
	}
	if (runTier !== undefined && runEnd > runStart) {
		const seq = compiled[runTier];
		out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
	}
	return out;
}

/** One run of the working row: its own colours, lit by the shared wave. */
export interface ShimmerSegment {
	readonly text: string;
	readonly palette: ShimmerPalette;
}

/**
 * Sweep a single band across several differently-coloured runs, the way omp
 * lights `Working... (esc to interrupt)`: the hint keeps its quieter palette
 * while the same wave passes through it.
 */
export function createSegmentedShimmer(
	segments: readonly ShimmerSegment[],
	mode: ShimmerMode,
): (time: number) => string {
	const compiled = segments.map((segment) => ({ text: segment.text, compiled: compile(segment.palette) }));
	const lengths = compiled.map((entry) => countCodePoints(entry.text));
	const total = lengths.reduce((sum, length) => sum + length, 0);
	if (mode === "off" || total === 0) {
		const still = compiled.map((entry) => (entry.text ? `${entry.compiled.mid.open}${entry.text}${entry.compiled.mid.close}` : "")).join("");
		return () => still;
	}
	const intensityFn = mode === "kitt" ? kittIntensity : classicIntensity;
	return (time: number): string => {
		const band = activeBand(mode, time, total);
		let out = "";
		let offset = 0;
		for (let index = 0; index < compiled.length; index++) {
			const entry = compiled[index];
			if (!entry) continue;
			out += sweep(entry.text, entry.compiled, intensityFn, time, band, offset, total);
			offset += lengths[index] ?? 0;
		}
		return out;
	};
}

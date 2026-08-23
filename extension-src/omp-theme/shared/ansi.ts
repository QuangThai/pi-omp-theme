import { safeTruncateToWidth, safeVisibleWidth } from "./render-budget.js";

function isFinal(byte: string): boolean {
	return byte >= "@" && byte <= "~";
}

const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

function xterm256ToRgb(index: number): { r: number; g: number; b: number } | undefined {
	if (index >= 0 && index < 16) {
		// Base 16 palette approximation used by the gradient logic.
		const base = [
			[0, 0, 0],
			[128, 0, 0],
			[0, 128, 0],
			[128, 128, 0],
			[0, 0, 128],
			[128, 0, 128],
			[0, 128, 128],
			[192, 192, 192],
			[128, 128, 128],
			[255, 0, 0],
			[0, 255, 0],
			[255, 255, 0],
			[0, 0, 255],
			[255, 0, 255],
			[0, 255, 255],
			[255, 255, 255],
		] as const;
		const entry = base[index] ?? [0, 0, 0];
		const [r, g, b] = entry;
		return { r, g, b };
	}
	if (index >= 16 && index < 232) {
		const cube = index - 16;
		return {
			r: CUBE_STEPS[Math.floor(cube / 36)] ?? 0,
			g: CUBE_STEPS[Math.floor((cube % 36) / 6)] ?? 0,
			b: CUBE_STEPS[cube % 6] ?? 0,
		};
	}
	if (index >= 232 && index < 256) {
		const gray = 8 + 10 * (index - 232);
		return { r: gray, g: gray, b: gray };
	}
	return undefined;
}

/**
 * Parse an ANSI foreground prefix into RGB. Supports 24-bit `38;2;r;g;b` and
 * 256-color `38;5;N` forms; returns undefined when the prefix is empty or not
 * a foreground color (e.g. `38;5;Nm` reset fragments).
 */
export function parseAnsiFgToRgb(prefix: string): { r: number; g: number; b: number } | undefined {
	const esc = "\u001b";
	const direct = new RegExp(`^${esc}\\[38;2;(\\d{1,3});(\\d{1,3});(\\d{1,3})m$`).exec(prefix);
	if (direct) {
		const r = Number.parseInt(direct[1] ?? "0", 10);
		const g = Number.parseInt(direct[2] ?? "0", 10);
		const b = Number.parseInt(direct[3] ?? "0", 10);
		if (r <= 255 && g <= 255 && b <= 255) return { r, g, b };
	}
	const indexed = new RegExp(`^${esc}\\[38;5;(\\d{1,3})m$`).exec(prefix);
	if (indexed) {
		const index = Number.parseInt(indexed[1] ?? "0", 10);
		if (index <= 255) return xterm256ToRgb(index);
	}
	return undefined;
}
export function stripAnsi(value: string): string {
	let output = "";
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) !== 27) {
			output += value[i];
			continue;
		}
		i++;
		if (value[i] === "[") {
			while (i + 1 < value.length && !isFinal(value[i + 1] ?? "")) i++;
			i++;
		} else if (value[i] === "]") {
			while (i + 1 < value.length && value.charCodeAt(i + 1) !== 7) {
				i++;
				if (value.charCodeAt(i) === 27 && value[i + 1] === "\\") {
					i++;
					break;
				}
			}
			// Consume the OSC terminator (BEL, or the ESC\\ already consumed above)
			// so it is not emitted as a visible character.
			if (i + 1 < value.length && value.charCodeAt(i + 1) === 7) i++;
		}
	}
	return output;
}
/**
 * Terminal column width, measured the way Pi's renderer measures it. Counting
 * code points instead undercounts wide glyphs (CJK, emoji), and a line that
 * measures narrow here but wide in Pi trips the renderer's width guard, which
 * throws and tears down the TUI.
 */
export function visibleWidth(value: string): number {
	return safeVisibleWidth(value);
}
const ANSI_RESET = "\x1b[0m";

export function resetAnsi(value: string): string {
	return `${value}${ANSI_RESET}`;
}

/** Return the value unchanged when it fits the width; truncate it otherwise. */
export function fitAnsiWidth(value: string, width: number, ellipsis = "…"): string {
	return visibleWidth(value) <= width ? value : truncateAnsi(value, width, ellipsis);
}
/**
 * Cut `value` to `width` columns. Cutting per UTF-16 code unit instead splits
 * surrogate pairs into replacement characters and miscounts wide glyphs, so the
 * cut is delegated to the grapheme- and column-aware helper.
 */
export function truncateAnsi(value: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return resetAnsi(value);
	const truncated = safeTruncateToWidth(value, width, ellipsis);
	return truncated.endsWith(ANSI_RESET) ? truncated : resetAnsi(truncated);
}
export function wrapAnsi(value: string, width: number): string[] {
	if (width <= 0) return [""];
	const lines: string[] = [];
	let line = "";
	for (const word of value.split(/\s+/)) {
		const next = line ? `${line} ${word}` : word;
		if (visibleWidth(next) <= width) line = next;
		else {
			if (line) lines.push(resetAnsi(line));
			line = truncateAnsi(word, width);
		}
	}
	if (line || lines.length === 0) lines.push(resetAnsi(line));
	return lines;
}

// ── Hex color + background helpers ──

export const RESET_BACKGROUND = "\x1b[49m";
export const ERASE_TO_END_OF_LINE = "\x1b[K";
const ESC = "\x1b";

export function isHexColor(value: string): boolean {
	const cleaned = value.replace("#", "");
	return cleaned.length === 3
		? /^[0-9a-fA-F]{3}$/.test(cleaned)
		: (cleaned.length === 6 || cleaned.length === 8) && /^[0-9a-fA-F]+$/.test(cleaned);
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length === 3) {
		const r = Number.parseInt((cleaned[0] ?? "") + (cleaned[0] ?? ""), 16);
		const g = Number.parseInt((cleaned[1] ?? "") + (cleaned[1] ?? ""), 16);
		const b = Number.parseInt((cleaned[2] ?? "") + (cleaned[2] ?? ""), 16);
		return { r, g, b };
	}
	if ((cleaned.length !== 6 && cleaned.length !== 8) || !/^[0-9a-fA-F]+$/.test(cleaned)) {
		return { r: 0, g: 0, b: 0 };
	}
	const r = Number.parseInt(cleaned.slice(0, 2), 16);
	const g = Number.parseInt(cleaned.slice(2, 4), 16);
	const b = Number.parseInt(cleaned.slice(4, 6), 16);
	return { r, g, b };
}

function channelToHex(value: number): string {
	return Math.max(0, Math.min(255, Math.round(value)))
		.toString(16)
		.padStart(2, "0");
}

export function rgbToHex(rgb: { r: number; g: number; b: number }): string {
	return `#${channelToHex(rgb.r)}${channelToHex(rgb.g)}${channelToHex(rgb.b)}`;
}

const CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function _ansi256ToRgb(index: number): { r: number; g: number; b: number } {
	if (index >= 232) {
		const gray = 8 + (index - 232) * 10;
		return { r: gray, g: gray, b: gray };
	}
	const cubeIndex = Math.max(0, index - 16);
	const redIndex = Math.floor(cubeIndex / 36);
	const greenIndex = Math.floor((cubeIndex % 36) / 6);
	const blueIndex = cubeIndex % 6;
	return { r: CUBE_VALUES[redIndex] ?? 0, g: CUBE_VALUES[greenIndex] ?? 0, b: CUBE_VALUES[blueIndex] ?? 0 };
}

const _ANSI_16_RGB: ReadonlyArray<readonly [number, number, number]> = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
] as const;

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function findClosestCubeIndex(value: number): number {
	let minDist = Number.POSITIVE_INFINITY;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - (CUBE_VALUES[i] ?? 0));
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function findClosestGrayIndex(gray: number): number {
	let minDist = Number.POSITIVE_INFINITY;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - (GRAY_VALUES[i] ?? 0));
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function rgbTo256(r: number, g: number, b: number): number {
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx] ?? 0;
	const cubeG = CUBE_VALUES[gIdx] ?? 0;
	const cubeB = CUBE_VALUES[bIdx] ?? 0;
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx] ?? 0;
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	const spread = Math.max(r, g, b) - Math.min(r, g, b);
	if (spread < 10 && grayDist < cubeDist) return grayIndex;
	return cubeIndex;
}

/** Color-mode-aware escape prefix/suffix pairs for a hex color (cached per mode+hex). */
function colorEscapes(mode: string, hex: string, kind: "fg" | "bg"): { prefix: string; suffix: string } | undefined {
	if (!isHexColor(hex)) return undefined;
	const { r, g, b } = hexToRgb(hex);
	const cacheKey = `${mode}:${kind}:${hex}`;
	const cache = kind === "fg" ? fgEscapeCache : bgEscapeCache;
	let cached = cache.get(cacheKey);
	if (!cached) {
		if (mode === "256color") {
			const idx = rgbTo256(r, g, b);
			cached = {
				prefix: `\x1b[${kind === "fg" ? 38 : 48};5;${idx}m`,
				suffix: kind === "fg" ? "\x1b[39m" : RESET_BACKGROUND,
			};
		} else {
			cached = {
				prefix: `\x1b[${kind === "fg" ? 38 : 48};2;${r};${g};${b}m`,
				suffix: kind === "fg" ? "\x1b[39m" : RESET_BACKGROUND,
			};
		}
		cache.set(cacheKey, cached);
	}
	return cached;
}

const fgEscapeCache = new Map<string, { prefix: string; suffix: string }>();
const bgEscapeCache = new Map<string, { prefix: string; suffix: string }>();

/** Foreground-styling helper: accepts a theme (for getColorMode) or "truecolor". */
export function fgHex(theme: { getColorMode?: () => string } | undefined, hex: string, text: string): string {
	const mode = typeof theme?.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	const escapes = colorEscapes(mode, hex, "fg");
	if (!escapes) return text;
	return `${escapes.prefix}${text}${escapes.suffix}`;
}

/** Background ANSI prefix for a hex color, or "" when not a hex color. */
export function bgHexAnsi(theme: { getColorMode?: () => string } | undefined, hex: string): string {
	const mode = typeof theme?.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	return colorEscapes(mode, hex, "bg")?.prefix ?? "";
}

export function bgHex(theme: { getColorMode?: () => string } | undefined, hex: string, text: string): string {
	const mode = typeof theme?.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	const escapes = colorEscapes(mode, hex, "bg");
	if (!escapes) return text;
	return `${escapes.prefix}${text}${escapes.suffix}`;
}

/** Whether an SGR code sequence contains a background-affecting action (set/reset). */
function finalBackgroundAction(rawCodes: string): "none" | "reset" | "set" {
	const codes = rawCodes.split(";").filter(Boolean);
	if (codes.length === 0) return "reset";
	let action: "none" | "reset" | "set" = "none";
	const sgrColorParameterEnd = (index: number): number => {
		const code = Number(codes[index]);
		if (code !== 38 && code !== 48) return index;
		const mode = Number(codes[index + 1]);
		if (mode === 2) return Math.min(codes.length - 1, index + 4);
		if (mode === 5) return Math.min(codes.length - 1, index + 2);
		return index;
	};
	for (let i = 0; i < codes.length; i++) {
		const code = Number(codes[i]);
		if (code === 0 || code === 49) {
			action = "reset";
			continue;
		}
		if (code === 48) {
			action = "set";
			i = sgrColorParameterEnd(i);
			continue;
		}
		if (code === 38) {
			i = sgrColorParameterEnd(i);
			continue;
		}
		if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) action = "set";
	}
	return action;
}

function removeStandaloneBackgroundReset(rawCodes: string): string {
	const codes = rawCodes.split(";").filter(Boolean);
	if (codes.length === 0) return "0";
	const rebuilt: string[] = [];
	const sgrColorParameterEnd = (index: number): number => {
		const code = Number(codes[index]);
		if (code !== 38 && code !== 48) return index;
		const mode = Number(codes[index + 1]);
		if (mode === 2) return Math.min(codes.length - 1, index + 4);
		if (mode === 5) return Math.min(codes.length - 1, index + 2);
		return index;
	};
	for (let i = 0; i < codes.length; i++) {
		const code = Number(codes[i]);
		if (code === 49) continue;
		const end = sgrColorParameterEnd(i);
		for (let j = i; j <= end; j++) rebuilt.push(codes[j] ?? "");
		i = end;
	}
	return rebuilt.join(";");
}

/** Re-apply a background after reset sequences so a fill survives nested resets. */
export function keepAnsiBackgroundAcrossResets(text: string, bgAnsi: string): string {
	if (!text) return text;
	return text.replace(new RegExp(`${ESC}\\[([0-9;]*)m`, "g"), (sequence, rawCodes) => {
		const codes = String(rawCodes ?? "");
		if (finalBackgroundAction(codes) !== "reset") return sequence;
		const rebuilt = removeStandaloneBackgroundReset(codes);
		return `${rebuilt ? `\x1b[${rebuilt}m` : ""}${bgAnsi}`;
	});
}

/** Wrap text in a background fill that survives nested resets; optional fill-to-end-of-line. */
export function wrapAnsiBackground(text: string, bgAnsi: string, options: { fillToEnd?: boolean } = {}): string {
	if (!bgAnsi || bgAnsi === RESET_BACKGROUND) return text;
	const body = keepAnsiBackgroundAcrossResets(text, bgAnsi);
	const fill = options.fillToEnd ? `${bgAnsi}${ERASE_TO_END_OF_LINE}` : "";
	return `${bgAnsi}${body}${fill}${RESET_BACKGROUND}`;
}

import { hexToAnsiPrefix, type ResolvedTheme } from "../../domain/theme.js";
import { fitAnsiWidth, parseAnsiFgToRgb, visibleWidth } from "../../shared/ansi.js";

/**
 * Compact startup logo header. Renders the block-art Pi logo with a
 * per-character accent gradient plus side details, with stacked/truncated
 * fallbacks for narrow widths. Pure render: color comes only from the
 * resolved theme.
 */

export const PI_LOGO_LINES = [
	"████████████╗",
	"████████████║",
	"████╔═══████║",
	"████║   ████║",
	"████████╬═══████╗",
	"████████║   ████║ ",
	"████╔═══╝   ████║",
	"████║       ████║",
	"╚═══╝       ╚═══╝",
] as const;

const LOGO_PALETTE_STEPS = 24;
const LOGO_MAX_DARKEN = 0.18;
const LOGO_MAX_LIGHTEN = 0.18;
const LOGO_ROW_PHASE_STEP = 0.12;
const LOGO_GAP = "   ";
/** Minimum side-detail width before the logo collapses to stacked lines. */
const LOGO_SIDE_DETAIL_MIN_WIDTH = 12;

type Rgb = { r: number; g: number; b: number };

function clampChannel(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

function interpolateRgb(start: Rgb, end: Rgb, factor: number): Rgb {
	return {
		r: clampChannel(start.r + (end.r - start.r) * factor),
		g: clampChannel(start.g + (end.g - start.g) * factor),
		b: clampChannel(start.b + (end.b - start.b) * factor),
	};
}

function darkenRgb(rgb: Rgb, amount: number): Rgb {
	return {
		r: clampChannel(rgb.r * (1 - amount)),
		g: clampChannel(rgb.g * (1 - amount)),
		b: clampChannel(rgb.b * (1 - amount)),
	};
}

function lightenRgb(rgb: Rgb, amount: number): Rgb {
	return {
		r: clampChannel(rgb.r + (255 - rgb.r) * amount),
		g: clampChannel(rgb.g + (255 - rgb.g) * amount),
		b: clampChannel(rgb.b + (255 - rgb.b) * amount),
	};
}

function buildLogoPalette(accent: Rgb): Rgb[] {
	return Array.from({ length: LOGO_PALETTE_STEPS }, (_, index) => {
		const progress = index / LOGO_PALETTE_STEPS;
		const wave = -Math.cos(progress * Math.PI * 2);
		return wave < 0 ? darkenRgb(accent, LOGO_MAX_DARKEN * -wave) : lightenRgb(accent, LOGO_MAX_LIGHTEN * wave);
	});
}

function sampleLogoGradient(palette: Rgb[], position: number): Rgb {
	const wrapped = ((position % 1) + 1) % 1;
	const scaled = wrapped * palette.length;
	const baseIndex = Math.floor(scaled) % palette.length;
	const nextIndex = (baseIndex + 1) % palette.length;
	const base = palette[baseIndex];
	const next = palette[nextIndex];
	if (!base || !next) return { r: 0, g: 0, b: 0 };
	return interpolateRgb(base, next, scaled - Math.floor(scaled));
}

function renderLogoGradientLine(line: string, palette: Rgb[], phase: number): string {
	const characters = [...line];
	const span = Math.max(characters.length - 1, 1);
	return characters
		.map((character, index) => {
			if (character === " ") return character;
			const color = sampleLogoGradient(palette, index / span + phase);
			return `${hexToAnsiPrefix(rgbToHex(color))}${character}`;
		})
		.join("");
}

function rgbToHex(rgb: Rgb): string {
	return `#${[rgb.r, rgb.g, rgb.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

let logoGradientCacheKey: string | undefined;
let logoGradientCacheLines: string[] | undefined;

/** Accent RGB resolved from the active theme, or undefined when uncolored. */
export function resolveAccentRgb(resolved: ResolvedTheme): Rgb | undefined {
	const accentAnsi = resolved.color("accent");
	if (!accentAnsi) return undefined;
	return parseAnsiFgToRgb(accentAnsi);
}

/** The block-art logo lines, gradient-styled when an accent color is resolvable. */
export function styledLogoLines(resolved: ResolvedTheme): string[] {
	const accent = resolveAccentRgb(resolved);
	if (!accent) return [...PI_LOGO_LINES];
	const cacheKey = `${resolved.color("accent")}|${resolved.mode}`;
	if (cacheKey === logoGradientCacheKey && logoGradientCacheLines) return logoGradientCacheLines;
	const palette = buildLogoPalette(accent);
	logoGradientCacheLines = PI_LOGO_LINES.map((line, rowIndex) =>
		renderLogoGradientLine(line, palette, rowIndex * LOGO_ROW_PHASE_STEP),
	);
	logoGradientCacheKey = cacheKey;
	return logoGradientCacheLines;
}

/**
 * Assemble the compact startup header: gradient logo with side details when
 * wide enough, stacked logo + details next, and a minimal title/status pair
 * for very narrow terminals. Every returned line fits within `width`.
 */
export function compactLogoHeader(
	resolved: ResolvedTheme,
	details: readonly [title: string, hints: string, status: string],
	width: number,
): string[] {
	const logoLines = styledLogoLines(resolved);
	const logoWidth = Math.max(...PI_LOGO_LINES.map((line) => visibleWidth(line)));
	const safeWidth = Math.max(1, width);
	const detailWidth = safeWidth - logoWidth - visibleWidth(LOGO_GAP);

	if (detailWidth >= LOGO_SIDE_DETAIL_MIN_WIDTH) {
		const detailStartRow = Math.max(0, Math.floor((PI_LOGO_LINES.length - details.length) / 2));
		return PI_LOGO_LINES.map((plainLine, index) => {
			const logoPadding = " ".repeat(Math.max(0, logoWidth - visibleWidth(plainLine)));
			const detailIndex = index - detailStartRow;
			const detailText = details[detailIndex];
			const detail = detailText ? fitAnsiWidth(detailText, detailWidth) : "";
			return `${logoLines[index]}${logoPadding}${detail ? `${LOGO_GAP}${detail}` : ""}`;
		});
	}

	if (safeWidth >= logoWidth) {
		return [...logoLines, ...details.map((detail) => fitAnsiWidth(detail, safeWidth))];
	}

	return [details[0], details[2]].map((detail) => fitAnsiWidth(detail, safeWidth));
}

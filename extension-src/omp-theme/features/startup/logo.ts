import { hexToAnsiPrefix, type ResolvedTheme } from "../../domain/theme.js";
import { fitAnsiWidth, visibleWidth } from "../../shared/ansi.js";

/**
 * Compact startup logo header. Renders the block-art Pi logo in its coral,
 * blue, and gold brand colors plus side details, with stacked/truncated
 * fallbacks for narrow widths. Pure render: plain blocks under NO_COLOR.
 *
 * Silhouette and colors follow `@quandev104/pi-style` (MIT).
 */

export const PI_LOGO_LINES = [
	"████████████",
	"████████████",
	"████    ████",
	"████    ████",
	"████████    ████",
	"████████    ████",
	"████        ████",
	"████        ████",
] as const;

const LOGO_COLORS = {
	coral: hexToAnsiPrefix("#f09082"),
	blue: hexToAnsiPrefix("#509bb9"),
	gold: hexToAnsiPrefix("#f0c055"),
} as const;

// Coral cap and its right leg, blue P, gold i stem.
const COLORED_LOGO_LINES = PI_LOGO_LINES.map((line, row) =>
	line.replace(/█+/g, (blocks, column: number) => {
		const color =
			row < 2 || (row < 4 && column >= 8) ? LOGO_COLORS.coral : column >= 12 ? LOGO_COLORS.gold : LOGO_COLORS.blue;
		// Reset after each run so the logo cannot recolor padding or side details.
		return `${color}${blocks}\x1b[0m`;
	}),
);
const LOGO_GAP = "   ";
/** Minimum side-detail width before the logo collapses to stacked lines. */
const LOGO_SIDE_DETAIL_MIN_WIDTH = 12;

/** The block-art logo in its brand colors, or plain when NO_COLOR is active. */
export function styledLogoLines(resolved: ResolvedTheme): string[] {
	return resolved.noColor ? [...PI_LOGO_LINES] : [...COLORED_LOGO_LINES];
}

/**
 * Assemble the compact startup header: brand-colored logo with side details when
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

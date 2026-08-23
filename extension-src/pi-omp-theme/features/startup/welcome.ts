// The welcome card: a rounded, titled frame with the logo and identity on the
// left and stacked information panels on the right.
//
// Ported from omp's `modes/components/welcome.ts`, with one deliberate change:
// omp's middle panel lists LSP servers, which Pi has no equivalent for. The
// slot carries the tool providers instead — the same shape (a source, its
// status, and what it offers) and the same purpose: what this session can
// reach. Leaving it empty would just be a hole in the card.
//
// Panel heights are fixed slot counts so the card does not change height as
// sessions or providers come and go.

import type { ResolvedTheme } from "../../domain/theme.js";
import { truncateAnsi, visibleWidth } from "../../shared/ansi.js";
import { PI_LOGO_LINES, styledLogoLines } from "./logo.js";

export interface WelcomeProvider {
	readonly name: string;
	/** What the provider offers, already shortened for one line. */
	readonly detail: string;
}

export interface WelcomeSession {
	readonly name: string;
	readonly timeAgo: string;
}

export interface WelcomeData {
	/** Name shown in the top border, e.g. `pi-omp-theme v0.2.0`. */
	readonly label: string;
	readonly title: string;
	readonly model?: string | undefined;
	readonly provider?: string | undefined;
	readonly providers: readonly WelcomeProvider[];
	readonly sessions: readonly WelcomeSession[];
}

export const WELCOME_PROVIDER_SLOTS = 4;
export const WELCOME_SESSION_SLOTS = 4;

/** Below this the card cannot hold two columns and the caller falls back. */
export const WELCOME_MIN_WIDTH = 64;

const PREFERRED_LEFT_COLUMN = 26;
const MIN_RIGHT_COLUMN = 30;

/**
 * Pi's own prompt prefixes, taken from its startup hints
 * (`interactive-mode.js`: `rawKeyHint("/", "for commands")` and the two bash
 * forms). omp's card also lists `#` and `$`; Pi has neither, and showing them
 * would teach a shortcut that does nothing.
 */
const TIPS: readonly (readonly [string, string])[] = [
	["/", "for commands"],
	["!", "to run bash"],
	["!!", "to run bash (no context)"],
];

function centre(text: string, width: number): string {
	const used = visibleWidth(text);
	if (used >= width) return truncateAnsi(text, width, "");
	const left = Math.floor((width - used) / 2);
	return `${" ".repeat(left)}${text}${" ".repeat(width - used - left)}`;
}

function fit(text: string, width: number): string {
	const used = visibleWidth(text);
	if (used > width) return truncateAnsi(text, width, "…");
	return `${text}${" ".repeat(width - used)}`;
}

function panelHeading(theme: ResolvedTheme, label: string): string {
	return ` ${theme.apply("accent", label)}`;
}

function tipRows(theme: ResolvedTheme): string[] {
	const keyWidth = Math.max(...TIPS.map(([key]) => key.length));
	return TIPS.map(([key, meaning]) => ` ${theme.apply("dim", key.padEnd(keyWidth))} ${theme.apply("muted", meaning)}`);
}

function providerRows(theme: ResolvedTheme, providers: readonly WelcomeProvider[], width: number): string[] {
	if (providers.length === 0) return [` ${theme.apply("dim", "No tool providers")}`];
	return providers.slice(0, WELCOME_PROVIDER_SLOTS).map((provider) => {
		const mark = theme.apply("success", "●");
		const name = theme.apply("muted", provider.name);
		const room = width - visibleWidth(`  ${provider.name} `) - 1;
		const detail = room > 3 ? theme.apply("dim", truncateAnsi(provider.detail, room, "…")) : "";
		return ` ${mark} ${name}${detail ? ` ${detail}` : ""}`;
	});
}

function sessionRows(theme: ResolvedTheme, sessions: readonly WelcomeSession[], width: number): string[] {
	if (sessions.length === 0) return [` ${theme.apply("dim", "No recent sessions")}`];
	return sessions.slice(0, WELCOME_SESSION_SLOTS).map((session) => {
		// Reserve the age so it is never what gets cut; the name absorbs the rest.
		// One further cell keeps the longest row off the frame it sits inside.
		const age = ` (${session.timeAgo})`;
		const budget = Math.max(1, width - 4 - visibleWidth(age));
		const name = truncateAnsi(session.name, budget, "…");
		return ` ${theme.apply("dim", "•")} ${theme.apply("muted", name)}${theme.apply("dim", age)}`;
	});
}

function pad(rows: string[], slots: number): string[] {
	const out = [...rows.slice(0, slots)];
	while (out.length < slots) out.push("");
	return out;
}

/**
 * Render the card, or an empty array when the terminal is too narrow for two
 * columns — the caller keeps its compact header for that case.
 */
export function renderWelcome(theme: ResolvedTheme, data: WelcomeData, width: number): string[] {
	if (width < WELCOME_MIN_WIDTH) return [];
	const boxWidth = width;
	const contentWidth = boxWidth - 3; // │ + divider │ + │
	const logoWidth = Math.max(...PI_LOGO_LINES.map((line) => visibleWidth(line)));
	const leftColumn = Math.max(logoWidth, Math.min(PREFERRED_LEFT_COLUMN, contentWidth - MIN_RIGHT_COLUMN));
	const rightColumn = contentWidth - leftColumn;
	if (rightColumn < MIN_RIGHT_COLUMN) return [];

	// Centre the logo as one block, not line by line: its rows differ in width
	// (one carries a trailing space), and centring each on its own shifts rows
	// against each other by half a cell and ragged-edges the glyph.
	const logoIndent = " ".repeat(Math.max(0, Math.floor((leftColumn - logoWidth) / 2)));
	const logo = styledLogoLines(theme).map((line) => `${logoIndent}${line}`);
	const left = [
		"",
		centre(theme.apply("text", data.title), leftColumn),
		"",
		...logo,
		"",
		centre(theme.apply("muted", data.model ?? ""), leftColumn),
		centre(theme.apply("dim", data.provider ?? ""), leftColumn),
	];

	const rule = ` ${theme.apply("dim", "─".repeat(Math.max(0, rightColumn - 2)))}`;
	const right = [
		panelHeading(theme, "Tips"),
		...tipRows(theme),
		rule,
		panelHeading(theme, "Tool providers"),
		...pad(providerRows(theme, data.providers, rightColumn), WELCOME_PROVIDER_SLOTS),
		rule,
		panelHeading(theme, "Recent sessions"),
		...pad(sessionRows(theme, data.sessions, rightColumn), WELCOME_SESSION_SLOTS),
		"",
	];

	const dim = (glyph: string) => theme.apply("dim", glyph);
	const lines: string[] = [];

	// Top border carries the name, the way omp titles its card.
	const label = ` ${data.label} `;
	const lead = "─".repeat(3);
	const fill = Math.max(0, boxWidth - 2 - visibleWidth(lead) - visibleWidth(label));
	lines.push(
		`${dim("╭")}${dim(lead)}${theme.apply("muted", label)}${dim("─".repeat(fill))}${dim("╮")}`,
	);

	const rows = Math.max(left.length, right.length);
	for (let index = 0; index < rows; index++) {
		const leftCell = fit(left[index] ?? "", leftColumn);
		const rightCell = fit(right[index] ?? "", rightColumn);
		lines.push(`${dim("│")}${leftCell}${dim("│")}${rightCell}${dim("│")}`);
	}

	lines.push(`${dim("╰")}${dim("─".repeat(boxWidth - 2))}${dim("╯")}`);
	return lines;
}

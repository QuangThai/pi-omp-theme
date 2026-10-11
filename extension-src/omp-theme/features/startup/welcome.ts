// The welcome card: a rounded, titled frame with the logo and identity on the
// left and stacked information panels on the right.
//
// Ported from omp's `modes/components/welcome.ts`, with one deliberate change:
// omp's middle panel lists LSP servers, which Pi has no equivalent for. The
// slot carries the tool providers instead — the same shape (a source and what
// it offers) and the same purpose: what this session can reach. Leaving it
// empty would just be a hole in the card.
//
// The card keeps one height whatever it lists: it sits at the top of the
// transcript, and a header that changes height after scrolling away makes Pi
// clear and replay the whole screen. Both columns have the same number of rows;
// sections are packed from the top and unused rows collect at the bottom.
//
// A blank row pads the card top and bottom; a rule, not a second blank row,
// separates the right column's sections, so padding and a section break never
// look alike.

import type { ResolvedTheme } from "../../domain/theme.js";
import { truncateAnsi, visibleWidth } from "../../shared/ansi.js";
import { PI_LOGO_LINES, styledLogoLines } from "./logo.js";

export interface WelcomeProvider {
	readonly name: string;
	/** The provider's tool names, in display order. */
	readonly tools: readonly string[];
}

export interface WelcomeSession {
	readonly name: string;
	readonly timeAgo: string;
}

export interface WelcomeData {
	/** Label shown in the top border, e.g. `Pi v1.1.0`. */
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
/**
 * Widest the card grows. Past this the right column only gains empty space,
 * and a frame spanning a wide terminal reads as a wall of rules.
 */
export const WELCOME_MAX_WIDTH = 100;

const LEFT_COLUMN = 26;
const MIN_RIGHT_COLUMN = 30;
/** Columns between the divider and a heading, and the same before the frame. */
const PANEL_PAD = 2;
/** Items sit under their heading by this much. */
const ITEM_INDENT = 2;
/** Widest provider name before it is cut. */
const MAX_PROVIDER_NAME = 16;

/**
 * Pi's own prompt prefixes, taken from its startup hints
 * (`interactive-mode.js`: `rawKeyHint("/", "for commands")` and the two bash
 * forms). omp's card also lists `#` and `$`; Pi has neither, and showing them
 * would teach a shortcut that does nothing.
 *
 * `!!` is worded the way Pi's usage guide puts it ("run a command without
 * sending its output to the model"), not as its hint's "(no context)", which
 * reads like a note about context files such as AGENTS.md.
 */
const TIPS: readonly (readonly [string, string])[] = [
	["/", "commands"],
	["!", "bash"],
	["!!", "bash, not sent to model"],
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

/** Fixed rows of the card body; both columns are built to exactly this many. */
function bodyRows(): number {
	// Left: blank, title, blank, logo, blank, model, provider, blank.
	return PI_LOGO_LINES.length + 7;
}

function heading(theme: ResolvedTheme, label: string): string {
	return `${" ".repeat(PANEL_PAD)}${theme.apply("accent", label)}`;
}

/**
 * The line between two panels, inset to the panel text on both sides: touching
 * the divider or the frame would make the card read as a grid of cells.
 */
function rule(theme: ResolvedTheme, width: number): string {
	return `${" ".repeat(PANEL_PAD)}${theme.apply("borderMuted", "─".repeat(Math.max(0, width - PANEL_PAD * 2)))}`;
}

/**
 * `Tips   /  commands    !  bash    !!  bash, not sent to model` on one row;
 * tips that do not fit the column are left off rather than wrapped.
 */
function tipsRow(theme: ResolvedTheme, width: number): string {
	const label = "Tips";
	const room = width - PANEL_PAD * 2;
	let plain = label;
	let row = theme.apply("accent", label);
	for (const [index, [key, meaning]] of TIPS.entries()) {
		const gap = index === 0 ? "   " : "    ";
		const next = `${gap}${key}  ${meaning}`;
		if (visibleWidth(plain) + visibleWidth(next) > room) break;
		plain += next;
		row += `${gap}${theme.apply("text", key)}  ${theme.apply("dim", meaning)}`;
	}
	return `${" ".repeat(PANEL_PAD)}${row}`;
}

/** Tool names joined until they fill `room`, then `+N` for the rest. */
function toolList(tools: readonly string[], room: number): string {
	let shown = "";
	for (const [index, tool] of tools.entries()) {
		const candidate = shown ? `${shown}, ${tool}` : tool;
		const rest = tools.length - index - 1;
		const tail = rest > 0 ? `  +${rest}` : "";
		if (visibleWidth(candidate) + visibleWidth(tail) > room) {
			const hidden = tools.length - index;
			return shown ? `${shown}  +${hidden}` : `+${hidden}`;
		}
		shown = candidate;
	}
	return shown;
}

function providerRows(theme: ResolvedTheme, providers: readonly WelcomeProvider[], width: number): string[] {
	const indent = " ".repeat(PANEL_PAD + ITEM_INDENT);
	if (providers.length === 0) return [`${indent}${theme.apply("dim", "No tool providers")}`];
	const overflow = providers.length > WELCOME_PROVIDER_SLOTS;
	const listed = overflow ? providers.slice(0, WELCOME_PROVIDER_SLOTS - 1) : providers;
	const more = overflow ? `+${providers.length - listed.length} more` : "";
	const nameWidth = Math.min(
		MAX_PROVIDER_NAME,
		Math.max(visibleWidth(more), ...listed.map((provider) => visibleWidth(provider.name))),
	);
	const countWidth = Math.max(...listed.map((provider) => String(provider.tools.length).length));
	const room = Math.max(0, width - PANEL_PAD - ITEM_INDENT - PANEL_PAD - nameWidth - 2 - countWidth - 3);
	const rows = listed.map((provider) => {
		const name = theme.apply("muted", fit(provider.name, nameWidth));
		const count = theme.apply("dim", String(provider.tools.length).padStart(countWidth));
		const tools = room > 0 ? `   ${theme.apply("dim", toolList(provider.tools, room))}` : "";
		return `${indent}${name}  ${count}${tools}`;
	});
	if (overflow) {
		// The rest by name, in the tool column, so the row still says what is there.
		const names = providers
			.slice(listed.length)
			.map((provider) => provider.name)
			.join(", ");
		const rest = room > 0 ? `${" ".repeat(countWidth)}   ${theme.apply("dim", truncateAnsi(names, room, "…"))}` : "";
		rows.push(`${indent}${theme.apply("dim", fit(more, nameWidth))}  ${rest}`);
	}
	return rows;
}

function sessionRows(theme: ResolvedTheme, sessions: readonly WelcomeSession[], width: number): string[] {
	const indent = " ".repeat(PANEL_PAD + ITEM_INDENT);
	if (sessions.length === 0) return [`${indent}${theme.apply("dim", "No recent sessions")}`];
	const listed = sessions.slice(0, WELCOME_SESSION_SLOTS);
	// Ages share a right-aligned column so the names read as one list; the age
	// is reserved first so it is never what gets cut.
	const ageWidth = Math.max(...listed.map((session) => visibleWidth(session.timeAgo)));
	const nameWidth = Math.max(1, width - PANEL_PAD - ITEM_INDENT - PANEL_PAD - ageWidth - 2);
	return listed.map((session) => {
		const name = theme.apply("muted", fit(session.name, nameWidth));
		const age = theme.apply("dim", session.timeAgo.padStart(ageWidth));
		return `${indent}${name}  ${age}`;
	});
}

function pad(rows: string[], slots: number): string[] {
	const out = rows.slice(0, slots);
	while (out.length < slots) out.push("");
	return out;
}

/** Width of the card for a terminal body `width` wide, or 0 when it cannot fit. */
export function welcomeCardWidth(width: number): number {
	if (width < WELCOME_MIN_WIDTH) return 0;
	return Math.min(width, WELCOME_MAX_WIDTH);
}

/**
 * Render the card, or an empty array when the terminal is too narrow for two
 * columns — the caller keeps its compact header for that case.
 */
export function renderWelcome(theme: ResolvedTheme, data: WelcomeData, width: number): string[] {
	const boxWidth = welcomeCardWidth(width);
	if (boxWidth === 0) return [];
	const contentWidth = boxWidth - 3; // │ + divider │ + │
	const logoWidth = Math.max(...PI_LOGO_LINES.map((line) => visibleWidth(line)));
	const leftColumn = Math.max(logoWidth, Math.min(LEFT_COLUMN, contentWidth - MIN_RIGHT_COLUMN));
	const rightColumn = contentWidth - leftColumn;
	if (rightColumn < MIN_RIGHT_COLUMN) return [];
	const rows = bodyRows();

	// Centre the logo as one block, not line by line: its rows differ in width
	// (the cap is 12 cells, the rows with the i stem 16), and centring each on
	// its own shifts rows against each other and breaks the glyph apart.
	const logoIndent = " ".repeat(Math.max(0, Math.floor((leftColumn - logoWidth) / 2)));
	const logo = styledLogoLines(theme).map((line) => `${logoIndent}${line}`);
	const left = pad(
		[
			"",
			centre(theme.apply("text", data.title), leftColumn),
			"",
			...logo,
			"",
			centre(theme.apply("muted", data.model ?? ""), leftColumn),
			centre(theme.apply("dim", data.provider ?? ""), leftColumn),
		],
		rows,
	);

	// One blank row frames the panels top and bottom, the same as the left column,
	// and a rule separates the sections; the title row and the tips row line up.
	const right = pad(
		[
			"",
			tipsRow(theme, rightColumn),
			rule(theme, rightColumn),
			heading(theme, "Tool providers"),
			...providerRows(theme, data.providers, rightColumn),
			rule(theme, rightColumn),
			heading(theme, "Recent sessions"),
			...sessionRows(theme, data.sessions, rightColumn),
		],
		rows,
	);

	// The frame is chrome, drawn in the same quiet colour as the theme's other boxes.
	const frame = (glyph: string) => theme.apply("borderMuted", glyph);
	const lines: string[] = [];

	// Top border carries the name, the way omp titles its card.
	const label = ` ${data.label} `;
	const lead = "─".repeat(3);
	const fill = Math.max(0, boxWidth - 2 - visibleWidth(lead) - visibleWidth(label));
	lines.push(`${frame("╭")}${frame(lead)}${theme.apply("muted", label)}${frame("─".repeat(fill))}${frame("╮")}`);

	for (let index = 0; index < rows; index++) {
		const leftCell = fit(left[index] ?? "", leftColumn);
		const rightCell = fit(right[index] ?? "", rightColumn);
		lines.push(`${frame("│")}${leftCell}${frame("│")}${rightCell}${frame("│")}`);
	}

	lines.push(`${frame("╰")}${frame("─".repeat(boxWidth - 2))}${frame("╯")}`);
	return lines;
}

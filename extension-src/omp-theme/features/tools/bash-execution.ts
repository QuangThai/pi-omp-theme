// Boxed presentation for Pi's native direct bash execution (`!command` /
// `!!command` prefix in the input box). The native BashExecutionComponent draws
// plain full-width top/bottom bars; a fingerprint-certified additive render
// patch (see pi/compatibility-probe.ts) installs an own `render` on the
// prototype that re-frames the output into the same rounded box used by the
// boxed tool presentation: `╭─ ❯ Bash ⟳ ─╮`, boxed `$ command` + output body,
// `╰─ Exit 0 ─╯`.
//
// The renderer is a pure delegate: it falls back to the native (inherited
// Container) rendering whenever the theme cache is empty or the component
// shape is unsupported. Nothing about the native instance is mutated — the
// box is computed per render from the live component state.

import type { BoxTheme } from "../../shared/box.js";
import {
	boxBlankLine,
	boxInnerWidth,
	boxLabeledBorder,
	boxLine,
	boxWidth,
	formatBoxedRunningStatus,
	dropOmittedLines,
} from "../../shared/box.js";
import { getThemeExtra } from "../../shared/theme-extras.js";

let cachedTheme: BoxTheme | undefined;

/** Provide the active theme for the boxed bash execution display (session start / theme change). */
export function setBashExecutionTheme(theme: BoxTheme | undefined): void {
	cachedTheme = theme;
}

/** Structural view of the native BashExecutionComponent as used by the patch. */
interface BashExecutionInstance {
	command: string;
	status: "running" | "cancelled" | "error" | "complete";
	exitCode?: number | null;
	contentContainer: { render(width: number): string[] };
	/** Wall-clock start captured on the first boxed render for the live `◌ Running · Ns` footer. */
	piOmpThemeStart?: number;
}

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";

function bashTitleColor(theme: BoxTheme): string {
	// Honors the `bashPromptColor` theme extra, falling back to the bashMode
	// semantic color (the same source the boxed bash tool title uses).
	const extra = getThemeExtra(theme, "bashPromptColor");
	return extra || "bashMode";
}

function boldOf(theme: BoxTheme): (text: string) => string {
	return typeof theme?.bold === "function" ? theme.bold : (text: string) => text;
}

/** `❯ Bash ⟳/✘` — the same title language as the boxed bash tool call: a mark
 *  only when the run needs one, since success is already the quiet default. */
function bashBoxTitle(theme: BoxTheme, host: BashExecutionInstance): string {
	const name = "Bash";
	const bold = boldOf(theme);
	const prefix = theme.fg(bashTitleColor(theme), `❯ ${name}`);
	if (host.status === "running") return bold(`${prefix} ${theme.fg("text", "⟳")}`);
	if (host.status === "cancelled") return bold(theme.fg("warning", `❯ ${name} ✘`));
	if (host.status === "error") return bold(theme.fg("error", `❯ ${name} ✘`));
	return bold(prefix);
}

/** Bottom-border label: live running status with elapsed, or the terminal state. */
function bashBoxFooter(theme: BoxTheme, host: BashExecutionInstance): string {
	if (host.status === "running") {
		const elapsed = typeof host.piOmpThemeStart === "number" ? (Date.now() - host.piOmpThemeStart) / 1000 : undefined;
		return formatBoxedRunningStatus(theme, elapsed);
	}
	if (host.status === "cancelled") return theme.fg("warning", "Cancelled");
	if (host.status === "error") return theme.fg("error", `Exit ${host.exitCode ?? "?"}`);
	return theme.fg("text", "Exit 0");
}

/**
 * Render a BashExecutionComponent as the rounded box. Returns undefined so the
 * caller falls back to the native rendering whenever the theme is unavailable
 * or the component shape is not the certified layout.
 */
export function renderBashExecutionBox(instance: unknown, args: unknown[]): string[] | undefined {
	const theme = cachedTheme;
	const width = args[0];
	if (!theme || typeof width !== "number" || !Number.isFinite(width) || width <= 0) return undefined;
	const host = instance as BashExecutionInstance;
	const content = host.contentContainer;
	if (!content || typeof content.render !== "function") return undefined;
	try {
		if (host.piOmpThemeStart === undefined) host.piOmpThemeStart = Date.now();
		const renderedWidth = boxWidth(width);
		const inner = boxInnerWidth(renderedWidth);
		// The native Text children render one leading padding space per line;
		// drop it so boxLine's own side padding produces symmetric borders.
		const wrapped = content
			.render(inner)
			.map((line) => boxLine(theme, line.startsWith(" ") ? line.slice(1) : line, renderedWidth));
		return dropOmittedLines([
			"",
			boxLabeledBorder(theme, TOP_LEFT, TOP_RIGHT, bashBoxTitle(theme, host), undefined, renderedWidth),
			boxBlankLine(theme, renderedWidth),
			...wrapped,
			boxBlankLine(theme, renderedWidth),
			boxLabeledBorder(theme, BOTTOM_LEFT, BOTTOM_RIGHT, bashBoxFooter(theme, host), undefined, renderedWidth),
		]);
	} catch {
		return undefined;
	}
}

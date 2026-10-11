import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfigDetailed } from "../extension-src/omp-theme/domain/config-normalization.js";
import { hexToAnsiPrefix, type ResolvedTheme } from "../extension-src/omp-theme/domain/theme.js";
import { renderStartup } from "../extension-src/omp-theme/features/startup/index.js";
import { compactLogoHeader, PI_LOGO_LINES, styledLogoLines } from "../extension-src/omp-theme/features/startup/logo.js";
import { renderWelcome } from "../extension-src/omp-theme/features/startup/welcome.js";
import { stripAnsi, visibleWidth } from "../extension-src/omp-theme/shared/ansi.js";

const themeWith = (noColor: boolean): ResolvedTheme => ({
	color: () => "",
	apply: (_token, text) => text,
	rainbow: (text) => text,
	glyph: () => "π",
	mode: "unicode",
	noColor,
});

const CORAL = hexToAnsiPrefix("#f09082");
const BLUE = hexToAnsiPrefix("#509bb9");
const GOLD = hexToAnsiPrefix("#f0c055");

/** Each run of blocks in a row, as [first column, length, color prefix]. */
function runs(line: string): [number, number, string][] {
	const out: [number, number, string][] = [];
	let column = 0;
	for (const match of line.matchAll(/(\x1b\[[0-9;]*m)?(█+|\s+)(\x1b\[0m)?/g)) {
		const text = match[2] ?? "";
		if (text.startsWith("█")) out.push([column, text.length, match[1] ?? ""]);
		column += text.length;
	}
	return out;
}

test("the logo is the coral, blue and gold block Pi", () => {
	assert.equal(PI_LOGO_LINES.length, 8);
	const lines = styledLogoLines(themeWith(false));
	assert.deepEqual(lines.map(stripAnsi), [...PI_LOGO_LINES]);
	assert.deepEqual(lines.map(runs), [
		[[0, 12, CORAL]],
		[[0, 12, CORAL]],
		[[0, 4, BLUE], [8, 4, CORAL]],
		[[0, 4, BLUE], [8, 4, CORAL]],
		[[0, 8, BLUE], [12, 4, GOLD]],
		[[0, 8, BLUE], [12, 4, GOLD]],
		[[0, 4, BLUE], [12, 4, GOLD]],
		[[0, 4, BLUE], [12, 4, GOLD]],
	]);
	// Every colored run is closed, so nothing after the logo inherits a color.
	for (const line of lines) assert.ok(line.endsWith("\x1b[0m"));
});

test("NO_COLOR keeps the logo as plain blocks", () => {
	assert.deepEqual(styledLogoLines(themeWith(true)), [...PI_LOGO_LINES]);
});

test("the compact header fits every width it is given", () => {
	const theme = themeWith(false);
	const details = ["π pi-omp-theme", "/ commands · ! bash", "● ready"] as const;
	for (const width of [80, 60, 40, 31, 20, 16, 8]) {
		const lines = compactLogoHeader(theme, details, width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${stripAnsi(line)}`);
	}
	// Beside the logo at 40 columns: the three details sit on rows 2 to 4.
	const beside = compactLogoHeader(theme, details, 40).map(stripAnsi);
	assert.equal(beside.length, 8);
	assert.ok(beside[2]?.endsWith("   π pi-omp-theme"));
	assert.ok(beside[4]?.endsWith("   ● ready"));
	// Narrower than the logo: only the title and status remain.
	assert.deepEqual(compactLogoHeader(theme, details, 10).map(stripAnsi), ["π pi-omp-…", "● ready"]);
});

test("the welcome card keeps its height and frame with the new logo", () => {
	const theme = themeWith(false);
	const card = renderWelcome(theme, { label: "Pi v1.1.0", title: "Welcome back!", providers: [], sessions: [] }, 100);
	assert.equal(card.length, 17);
	for (const line of card) assert.equal(visibleWidth(line), 100);
	const plain = card.map(stripAnsi);
	// The logo sits centred as one block in the 26-cell left column.
	const top = plain.findIndex((line) => line.includes("████████████"));
	assert.equal(plain[top]?.slice(1, 27), `     ${PI_LOGO_LINES[0]}         `);
	assert.equal(plain[top + 7]?.slice(1, 27), `     ${PI_LOGO_LINES[7]}     `);
	assert.ok(plain.every((line) => line.startsWith("│") || line.startsWith("╭") || line.startsWith("╰")));
});

test("startup renders the welcome card wide and the compact logo narrow", () => {
	const { config } = resolveConfigDetailed({ global: { preset: "claude-code" }, projectTrusted: true });
	const theme = { fg: (_color: string, text: string) => text };
	const snapshot = { reason: "startup" as const, project: "pi-omp-theme", resources: { sessions: [] } };
	const wide = renderStartup(snapshot, config, theme, 110).map(stripAnsi);
	const narrow = renderStartup(snapshot, config, theme, 40).map(stripAnsi);
	// No recent session yet, so no "back"; the card starts on Pi's one-column gutter.
	assert.ok(wide.some((line) => line.includes("Welcome!") && line.startsWith(" │")));
	assert.ok(wide.some((line) => line.includes(PI_LOGO_LINES[4])));
	assert.ok(!narrow.some((line) => line.includes("Welcome")));
	assert.ok(narrow.some((line) => line.includes(PI_LOGO_LINES[4])));
	for (const line of narrow) assert.ok(visibleWidth(line) <= 40);
});

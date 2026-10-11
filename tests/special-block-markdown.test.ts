import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import { renderSpecialMessageBlock, setSpecialBlockTheme } from "../extension-src/omp-theme/features/messages/special-blocks.js";
import { type BoxTheme, setBoxChrome, setBoxTheme } from "../extension-src/omp-theme/shared/box.js";

const CODE = "38;5;22";
const fg = (params: string) => (text: string) => `\x1b[${params}m${text}\x1b[39m`;

/** Pi's markdown theme shape; only inline code is coloured, so its colour is easy to follow. */
const markdownTheme = {
	heading: fg("38;5;30"),
	link: fg("38;5;31"),
	linkUrl: fg("38;5;32"),
	code: fg(CODE),
	codeBlock: fg("38;5;33"),
	codeBlockBorder: fg("38;5;34"),
	quote: fg("38;5;35"),
	quoteBorder: fg("38;5;36"),
	hr: fg("38;5;37"),
	listBullet: fg("38;5;38"),
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
	strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
} as unknown as MarkdownTheme;

/**
 * A theme shaped like Pi's: an empty colour token renders as the terminal's own
 * foreground (`\x1b[39m`), the way Titanium leaves `customMessageText` empty.
 */
function themeWith(customMessageText: string): BoxTheme {
	return {
		fg(color, text) {
			if (color === "customMessageText") return `${customMessageText || "\x1b[39m"}${text}\x1b[39m`;
			return `\x1b[38;5;${color === "border" ? 1 : 2}m${text}\x1b[39m`;
		},
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	};
}

/** Each visible character with the foreground it is drawn in. */
function paint(line: string): Array<{ ch: string; fg: string }> {
	const cells: Array<{ ch: string; fg: string }> = [];
	let current = "default";
	const pattern = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|([^\x1b])/gu;
	for (const match of line.matchAll(pattern)) {
		if (match[2] !== undefined) {
			cells.push({ ch: match[2], fg: current });
		} else if (match[1] !== undefined) {
			const params = match[1];
			if (params.startsWith("38;")) current = params;
			else if (params.split(";").some((param) => param === "" || param === "0" || param === "39")) current = "default";
		}
	}
	return cells;
}

function drawnIn(line: string, color: string): string {
	return paint(line)
		.filter((cell) => cell.fg === color)
		.map((cell) => cell.ch)
		.join("");
}

function renderCustomMessage(theme: BoxTheme, content: string): string[] {
	setSpecialBlockTheme(theme);
	let child: Component | undefined;
	const instance = {
		message: { customType: "teammate-notification", content },
		markdownTheme,
		addChild(component: unknown) {
			child = component as Component;
		},
		removeChild() {},
		setBgFn() {},
	};
	renderSpecialMessageBlock(
		"native-custom-message",
		() => {
			throw new Error("the custom message patch fell back to Pi");
		},
		instance,
		[],
	);
	assert.ok(child, "the patch should attach a component");
	return child.render(80);
}

const TABLE = "| Script | Command |\n|---|---|\n| `build` | `tsup` |\n| `typecheck` | `tsc --noEmit` |";

after(() => {
	setSpecialBlockTheme(undefined);
	setBoxTheme(undefined);
	setBoxChrome("boxed");
});

for (const chrome of ["boxed", "light", "inline"] as const) {
	test(`${chrome}: a table cell ending in code keeps its colour off the borders when customMessageText is empty`, () => {
		setBoxChrome(chrome);
		setBoxTheme(themeWith(""));
		const lines = renderCustomMessage(themeWith(""), TABLE);
		const build = lines.find((line) => line.includes("build"));
		const typecheck = lines.find((line) => line.includes("typecheck"));
		assert.ok(build && typecheck, "the table rows should render");
		// Only the code itself is drawn in the code colour: not the padding, the `│` between cells, or the edge.
		assert.equal(drawnIn(build, CODE), "buildtsup");
		assert.equal(drawnIn(typecheck, CODE), "typechecktsc --noEmit");
	});
}

test("text in an empty customMessageText stays in the terminal foreground around inline code", () => {
	setBoxChrome("boxed");
	setBoxTheme(themeWith(""));
	const lines = renderCustomMessage(themeWith(""), "plain words then `x` and more");
	const line = lines.find((row) => row.includes("plain words"));
	assert.ok(line);
	assert.equal(drawnIn(line, CODE), "x");
	assert.ok(drawnIn(line, "default").includes("plain words then  and more"));
});

test("a coloured customMessageText still styles the body text", () => {
	setBoxChrome("boxed");
	const theme = themeWith("\x1b[38;5;15m");
	setBoxTheme(theme);
	const lines = renderCustomMessage(theme, "plain words then `x`\n\n" + TABLE);
	const line = lines.find((row) => row.includes("plain words"));
	assert.ok(line);
	assert.equal(drawnIn(line, "38;5;15").replaceAll(" ", ""), "plainwordsthen");
	assert.equal(drawnIn(line, CODE), "x");
	const build = lines.find((row) => row.includes("build"));
	assert.ok(build);
	assert.equal(drawnIn(build, CODE), "buildtsup");
});

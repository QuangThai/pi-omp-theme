import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { setBoxTheme, type BoxTheme } from "../extension-src/omp-theme/shared/box.js";
import { bashTool, resetBashTreeRegistry } from "../extension-src/omp-theme/features/tools/boxed/bash.js";
import { grepTool, resetGrepRegistry } from "../extension-src/omp-theme/features/tools/boxed/grep.js";
import {
	type GrepDisplayLine,
	type GrepMatch,
	parseGrepDisplayOutput,
	renderGrepTree,
} from "../extension-src/omp-theme/features/tools/boxed/output-tree.js";
import { setToolsRenderConfig } from "../extension-src/omp-theme/features/tools/boxed/session-config.js";
import type { BoxedToolContext } from "../extension-src/omp-theme/features/tools/boxed/shared.js";

const theme: BoxTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function context(toolCallId: string, expanded = false): BoxedToolContext {
	return {
		args: { pattern: "needle", path: "." },
		toolCallId,
		invalidate() {},
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError: false,
	};
}

before(() => {
	setBoxTheme(theme);
	setToolsRenderConfig({ maxCollapsedLines: 10, maxExpandedLines: 50, nerdFonts: false });
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
});

beforeEach(() => {
	resetBashTreeRegistry();
	resetGrepRegistry();
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
});

after(() => {
	setBoxTheme(undefined);
});

test("collapsed grep enforces a strict six-row body and favors file breadth", () => {
	const matches: GrepMatch[] = Array.from({ length: 4 }, (_, fileIndex) =>
		Array.from({ length: 3 }, (_, matchIndex) => ({
			file: `file-${fileIndex + 1}.ts`,
			line: matchIndex + 1,
			content: `needle ${fileIndex + 1}.${matchIndex + 1}`,
		})),
	).flat();

	const lines = renderGrepTree(theme, "Grep", matches, 120, { lineBudget: 6, expanded: false });
	const body = lines.slice(1);

	assert.equal(body.length, 6);
	assert.ok(body.some((line) => line.includes("file-1.ts")));
	assert.ok(body.some((line) => line.includes("file-2.ts")));
	assert.ok(body.some((line) => line.includes("more matches")));
	assert.ok(body.some((line) => line.includes("more files")));
	assert.ok(body.every((line) => !line.includes("├─ *")), "code rows should use a quiet continuation gutter");
});

test("line budgets hold across file and match distributions", () => {
	for (let fileCount = 1; fileCount <= 6; fileCount++) {
		for (let matchesPerFile = 1; matchesPerFile <= 6; matchesPerFile++) {
			const matches: GrepMatch[] = Array.from({ length: fileCount }, (_, fileIndex) =>
				Array.from({ length: matchesPerFile }, (_, matchIndex) => ({
					file: `file-${fileIndex}.ts`,
					line: matchIndex + 1,
					content: "needle",
				})),
			).flat();
			for (let budget = 0; budget <= 10; budget++) {
				const collapsed = renderGrepTree(theme, "Grep", matches, 80, { lineBudget: budget, expanded: false });
				const expanded = renderGrepTree(theme, "Grep", matches, 80, { lineBudget: budget, expanded: true });
				assert.ok(collapsed.length - 1 <= budget, `collapsed overflow: ${fileCount}/${matchesPerFile}/${budget}`);
				assert.ok(expanded.length - 1 <= budget, `expanded overflow: ${fileCount}/${matchesPerFile}/${budget}`);
			}
		}
	}
});

test("expanded grep restores context while collapsed mode keeps only matches", () => {
	const displayLines: GrepDisplayLine[] = [
		{ file: "file.ts", line: 9, content: "before", isMatch: false },
		{ file: "file.ts", line: 10, content: "needle", isMatch: true },
		{ file: "file.ts", line: 11, content: "after", isMatch: false },
	];
	const matches: GrepMatch[] = [{ file: "file.ts", line: 10, content: "needle" }];

	const collapsed = renderGrepTree(theme, "Grep", matches, 120, {
		lineBudget: 6,
		expanded: false,
		displayLines,
	});
	const expanded = renderGrepTree(theme, "Grep", matches, 120, {
		lineBudget: 24,
		expanded: true,
		displayLines,
	});

	assert.ok(!collapsed.join("\n").includes("before"));
	assert.ok(!collapsed.join("\n").includes("more lines"));
	assert.ok(expanded.join("\n").includes("before"));
	assert.ok(expanded.join("\n").includes("after"));
	assert.ok(expanded.length > collapsed.length);
});

test("tool-level expanded state restores context after a collapsed render", () => {
	const collapsedContext = context("toggle", false);
	const collapsed = grepTool.call({ pattern: "needle", path: "." }, theme, collapsedContext);
	grepTool.result(
		{
			content: [{ type: "text", text: "src/file.ts-9- before\nsrc/file.ts:10: needle\nsrc/file.ts-11- after" }],
			details: undefined,
		},
		{ expanded: false, isPartial: false },
		theme,
		collapsedContext,
	);
	assert.ok(!collapsed.render(120).join("\n").includes("before"));

	const expanded = grepTool.call({ pattern: "needle", path: "." }, theme, context("toggle", true));
	assert.ok(expanded.render(120).join("\n").includes("before"));
	assert.ok(expanded.render(120).join("\n").includes("after"));
});

test("native grep parser preserves context and identifies actual matches", () => {
	const parsed = parseGrepDisplayOutput(
		["src/file-name.ts-9- before", "src/file-name.ts:10: needle", "src/file-name.ts-11- after"].join("\n"),
	);

	assert.deepEqual(
		parsed.map((line) => ({ file: line.file, line: line.line, isMatch: line.isMatch })),
		[
			{ file: "src/file-name.ts", line: 9, isMatch: false },
			{ file: "src/file-name.ts", line: 10, isMatch: true },
			{ file: "src/file-name.ts", line: 11, isMatch: false },
		],
	);
});

test("content delimiters and numeric path segments do not corrupt grep boundaries", () => {
	const parsed = parseGrepDisplayOutput(
		[
			"dir-2024/file.ts-9- before-88-context",
			"dir-2024/file.ts:10: needle:99: still content",
			"dir-2024/file.ts-11- after-77-context",
		].join("\n"),
	);

	assert.deepEqual(
		parsed.map((line) => ({ file: line.file, line: line.line, content: line.content })),
		[
			{ file: "dir-2024/file.ts", line: 9, content: "before-88-context" },
			{ file: "dir-2024/file.ts", line: 10, content: "needle:99: still content" },
			{ file: "dir-2024/file.ts", line: 11, content: "after-77-context" },
		],
	);
});

test("overlapping context windows deduplicate rows and upgrade matched lines", () => {
	const parsed = parseGrepDisplayOutput(
		[
			"src/file.ts:10: first match",
			"src/file.ts-11- shared context",
			"src/file.ts-12- second as context",
			"src/file.ts-10- first repeated as context",
			"src/file.ts-11- shared context",
			"src/file.ts:12: second match",
		].join("\n"),
	);

	assert.deepEqual(
		parsed.map((line) => [line.line, line.isMatch]),
		[
			[10, true],
			[11, false],
			[12, true],
		],
	);
});

test("grep header keeps native truncation metadata visible", () => {
	const ctx = context("truncated");
	const component = grepTool.call({ pattern: "needle", path: "." }, theme, ctx);
	grepTool.result(
		{
			content: [{ type: "text", text: "src/file.ts:10: needle\n[100 matches limit reached]" }],
			details: { matchLimitReached: 100, linesTruncated: true },
		},
		{ expanded: false, isPartial: false },
		theme,
		ctx,
	);

	const header = component.render(160)[0] ?? "";
	assert.match(header, /truncated: 100-match limit, long lines/);
});

test("historical notice-only results retain a generic truncated signal", () => {
	const ctx = context("historical");
	const component = grepTool.call({ pattern: "needle", path: "." }, theme, ctx);
	grepTool.result(
		{
			content: [{ type: "text", text: "src/file.ts:10: needle\n[100 matches limit reached]" }],
			details: undefined,
		},
		{ expanded: false, isPartial: false },
		theme,
		ctx,
	);

	assert.match(component.render(160)[0] ?? "", / · truncated/);
});

test("zero-match grep renders an explicit empty state", () => {
	const ctx = context("empty");
	const component = grepTool.call({ pattern: "missing", path: "." }, theme, ctx);
	grepTool.result(
		{ content: [{ type: "text", text: "No matches found" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		ctx,
	);

	assert.ok(component.render(120).some((line) => line.includes("No matches found")));
});

test("every rendered row remains within the terminal width", () => {
	const matches: GrepMatch[] = [
		{ file: "a/very/long/path/to/file.ts", line: 1234, content: `needle\t${"x".repeat(200)}` },
	];
	const lines = renderGrepTree(theme, "Grep with a very long header", matches, 32, {
		lineBudget: 6,
		expanded: false,
	});
	assert.ok(lines.every((line) => visibleWidth(line) <= 32));
});

test("directory-scoped and file-scoped grep links resolve against the correct base", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });

	const directoryContext = context("directory-links", true);
	const directoryComponent = grepTool.call(
		{ pattern: "needle", path: "extension-src" },
		theme,
		directoryContext,
	);
	grepTool.result(
		{ content: [{ type: "text", text: "omp-theme/file.ts:10: needle" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		directoryContext,
	);
	const directoryRender = directoryComponent.render(200).join("\n").replace(/\\/g, "/");
	assert.ok(directoryRender.includes("/extension-src/omp-theme/file.ts?line=10"));
	assert.ok(!directoryRender.includes("/extension-src/extension-src/"));

	const fileContext = context("file-links", true);
	const fileComponent = grepTool.call({ pattern: "needle", path: "package.json" }, theme, fileContext);
	grepTool.result(
		{ content: [{ type: "text", text: "package.json:10: needle" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		fileContext,
	);
	const fileRender = fileComponent.render(200).join("\n").replace(/\\/g, "/");
	assert.ok(fileRender.includes("/package.json?line=10"));
	assert.ok(!fileRender.includes("/package.json/package.json"));
});

test("bash rg semantic trees link file and line targets", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const base = context("bash-links", true);
	const ctx = { ...base, args: { command: "rg needle extension-src" } } satisfies BoxedToolContext;
	const component = bashTool.call({ command: "rg needle extension-src" }, theme, ctx);
	bashTool.result(
		{
			content: [{ type: "text", text: "extension-src/omp-theme/file.ts:10: needle" }],
			details: undefined,
		},
		{ expanded: true, isPartial: false },
		theme,
		ctx,
	);

	const rendered = component.render(200).join("\n").replace(/\\/g, "/");
	assert.ok(rendered.includes("/extension-src/omp-theme/file.ts?line=10"));
});

test("file and code-frame rows become OSC-8 links when supported", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const ctx = context("links", true);
	const component = grepTool.call({ pattern: "needle", path: "." }, theme, ctx);
	grepTool.result(
		{ content: [{ type: "text", text: "src/file.ts:10: needle" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		ctx,
	);

	const rendered = component.render(160).join("\n");
	assert.ok(rendered.includes("\x1b]8;"));
	assert.ok(rendered.includes("line=10"));
});

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	type BoxTheme,
	boxBlankLine,
	dropOmittedLines,
	renderBoxedToolCall as renderSharedBoxedCall,
	renderBoxedToolResult as renderSharedBoxedResult,
	setBoxChrome,
	TOOL_CONTENT_INDENT,
} from "../extension-src/omp-theme/shared/box.js";
import { stripAnsi } from "../extension-src/omp-theme/shared/ansi.js";
import { safeVisibleWidth } from "../extension-src/omp-theme/shared/render-budget.js";
import { createToolDecorationOwner } from "../extension-src/omp-theme/features/tools/index.js";
import { resetBatchRegistry } from "../extension-src/omp-theme/features/tools/boxed/batch.js";
import {
	renderBoxedToolCall,
	renderBoxedToolResult,
} from "../extension-src/omp-theme/features/tools/boxed/index.js";
import type { BoxedToolContext } from "../extension-src/omp-theme/features/tools/boxed/shared.js";

const theme: BoxTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function context(toolCallId: string, args: Record<string, unknown>, isPartial = false): BoxedToolContext {
	return {
		args,
		toolCallId,
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

function firstGlyphColumn(line: string): number {
	const plain = stripAnsi(line);
	const index = plain.search(/\S/u);
	return index < 0 ? 0 : index;
}

function assertWidthSafe(lines: string[], width: number): void {
	for (const line of lines) {
		assert.ok(safeVisibleWidth(line) <= width, `${safeVisibleWidth(line)} > ${width}: ${stripAnsi(line)}`);
	}
}

afterEach(() => {
	setBoxChrome("boxed");
	resetBatchRegistry();
});

test("boxed call/result share the outer anchor, content inset, and terminal width", () => {
	setBoxChrome("boxed");
	for (const width of [11, 12, 32, 89, 120]) {
		const call = renderSharedBoxedCall(theme, "Web Fetch", ["Url: https://example.test"], {
			resultSeen: true,
		}).render(width);
		const result = renderSharedBoxedResult(theme, () => ["response body"], {
			footerLines: ["0.10s"],
		}).render(width);
		const lines = [...call, ...result];

		assertWidthSafe(lines, width);
		assert.equal(firstGlyphColumn(call[0] ?? ""), 0);
		assert.equal(firstGlyphColumn(result[0] ?? ""), 0);
		if (width >= 32) {
			assert.equal(stripAnsi(call.find((line) => line.includes("Url:")) ?? "").indexOf("Url:"), TOOL_CONTENT_INDENT);
			assert.equal(
				stripAnsi(result.find((line) => line.includes("response body")) ?? "").indexOf("response body"),
				TOOL_CONTENT_INDENT,
			);
		}
	}
});

test("boxed breathing rows render while light chrome omits only frame padding", () => {
	setBoxChrome("boxed");
	const boxed = dropOmittedLines([boxBlankLine(theme, 12)]);
	assert.equal(boxed.length, 1);
	assert.equal(stripAnsi(boxed[0] ?? ""), "│          │");

	setBoxChrome("light");
	assert.deepEqual(dropOmittedLines([boxBlankLine(theme, 12)]), []);
	const light = renderSharedBoxedCall(theme, "Web Fetch", ["Url: https://example.test"], {
		resultSeen: true,
	}).render(32);
	assertWidthSafe(light, 32);
	assert.ok(light.every((line) => firstGlyphColumn(line) === 0));
});

test("compact-box owns custom call and result renderers instead of retaining a native inset", () => {
	const owner = createToolDecorationOwner({ style: "compact-box" });
	let nativeSelections = 0;
	const contentBox = { paddingX: 5, paddingY: 1, setBgFn(_fn: (text: string) => string) {} };
	const instance = {
		toolName: "web_fetch",
		toolCallId: "custom-web-fetch",
		args: { url: "https://example.test" },
		rendererState: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		contentBox,
		getRenderShell: () => "default",
		invalidate() {},
	};
	const nativeSelector = () => {
		nativeSelections++;
		return () => ({ invalidate() {}, render: () => ["     native custom renderer"] });
	};
	const rawContext = context("custom-web-fetch", instance.args);
	const callRenderer = owner.decorateToolRendererSelection(
		"tool-call-renderer",
		nativeSelector,
		instance,
		[],
	) as (args: object, theme: BoxTheme, context: BoxedToolContext) => { render(width: number): string[] };
	const resultRenderer = owner.decorateToolRendererSelection(
		"tool-result-renderer",
		nativeSelector,
		instance,
		[],
	) as (
		result: object,
		options: object,
		theme: BoxTheme,
		context: BoxedToolContext,
	) => { render(width: number): string[] };
	const call = callRenderer(instance.args, theme, rawContext).render(32);
	const result = resultRenderer(
		{ content: [{ type: "text", text: "fetched" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		rawContext,
	).render(32);

	assert.equal(nativeSelections, 0);
	assert.equal(contentBox.paddingX, 0);
	assert.equal(contentBox.paddingY, 0);
	assert.equal(firstGlyphColumn(call[0] ?? ""), 0);
	assert.equal(firstGlyphColumn(result[0] ?? ""), 0);
	assert.ok(![...call, ...result].join("\n").includes("native custom renderer"));
	assertWidthSafe([...call, ...result], 32);
	owner.dispose();
});

test("parallel quiet tools and the following custom box keep one outer column", () => {
	const firstRead = renderBoxedToolCall("read", { path: "src/a.ts" }, theme, context("read-a", { path: "src/a.ts" }));
	renderBoxedToolCall("read", { path: "src/b.ts" }, theme, context("read-b", { path: "src/b.ts" }));
	const customContext = context("custom-after-read", { query: "needle" });
	const custom = renderBoxedToolCall("custom_tool", customContext.args, theme, customContext);
	const readLines = firstRead.render(89);
	const customLines = custom.render(89);

	assert.equal(firstGlyphColumn(readLines[0] ?? ""), 0);
	assert.equal(firstGlyphColumn(customLines[0] ?? ""), 0);
	assert.match(stripAnsi(readLines[1] ?? ""), /^  [├└]─/u);
	assertWidthSafe([...readLines, ...customLines], 89);
});

test("compact-box normalizes a reduced custom-tool context without changing renderer ownership", () => {
	const owner = createToolDecorationOwner({ style: "compact-box" });
	const instance = {
		toolName: "custom_tool",
		toolCallId: "reduced-context",
		args: { value: 1 },
		rendererState: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		contentBox: { paddingX: 1, paddingY: 1, setBgFn(_fn: (text: string) => string) {} },
		getRenderShell: () => "default",
		invalidate() {},
	};
	const callRenderer = owner.decorateToolRendererSelection(
		"tool-call-renderer",
		() => undefined,
		instance,
		[],
	) as (args: object, theme: BoxTheme, context: object) => { render(width: number): string[] };
	const lines = callRenderer(instance.args, theme, {}).render(32);

	assert.equal(firstGlyphColumn(lines[0] ?? ""), 0);
	assertWidthSafe(lines, 32);
	assert.equal(owner.getDiagnostics().get("tool-call-renderer-normalized-context"), 1);
	owner.dispose();
});

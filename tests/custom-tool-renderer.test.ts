import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolDecorationOwner } from "../extension-src/omp-theme/features/tools/index.js";
import { Text, visibleWidth } from "@earendil-works/pi-tui";

test("compact-box frames Ask's own Q&A body instead of generic machine output", () => {
	const owner = createToolDecorationOwner({ style: "compact-box" });
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const instance = { toolName: "ask_user_question" };
	const ctx = {
		args: { questions: [{}] }, toolCallId: "ask-structured", invalidate() {}, lastComponent: undefined,
		state: {}, cwd: process.cwd(), executionStarted: true, argsComplete: true,
		isPartial: false, expanded: false, showImages: false, isError: false,
	};
	const body = new Text("Which approach should we use?\nFull questions and answers", 0, 0);
	let calls = 0;
	let invalidations = 0;
	const resultRenderer = (...args: unknown[]) => {
		calls++;
		assert.equal(args[3], ctx, "the native renderer must receive the original context");
		return { render: (width: number) => body.render(width), invalidate() { invalidations++; body.invalidate(); } };
	};
	try {
		const select = (subtype: "tool-call-renderer" | "tool-result-renderer", native: unknown) =>
			owner.decorateToolRendererSelection(subtype, () => native, instance, []) as
				(...args: unknown[]) => { render(width: number): string[]; invalidate(): void };
		const call = select("tool-call-renderer", () => assert.fail("keep the existing boxed Ask call"))(ctx.args, theme, ctx);
		const result = select("tool-result-renderer", resultRenderer)(
			{ content: [{ type: "text", text: "machine-id: machine-value" }], details: {} },
			{ expanded: false, isPartial: false }, theme, ctx,
		);
		for (const width of [24, 88]) {
			const lines = [...call.render(width), ...result.render(width)];
			const rendered = lines.join("\n");
			assert.match(rendered, /╭/);
			assert.match(rendered, /╰/);
			assert.match(rendered, /Which approach/);
			assert.match(rendered, /Full questions/);
			assert.doesNotMatch(rendered, /machine-id|machine-value/);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
		result.invalidate();
		assert.equal(invalidations, 1, "theme invalidation must reach the native component");
		assert.equal(calls, 1);
		assert.equal(owner.getDiagnostics().size, 0);
	} finally {
		owner.dispose();
	}
});

for (const toolName of ["todo_write", "todo_update", "todo_read", "web_fetch"]) {
	test(`compact-box keeps ${toolName} boxed even when it supplies native renderers`, () => {
		const owner = createToolDecorationOwner({ style: "compact-box" });
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const nativeRenderer = () => {
			assert.fail("non-Ask tools must retain the existing boxed rendering path");
		};
		try {
			for (const expanded of [false, true]) {
				for (const isError of [false, true]) {
					let background = (text: string) => `native background: ${text}`;
					const contentBox = {
						paddingX: 1,
						paddingY: 1,
						setBgFn(fn: (text: string) => string) { background = fn; },
					};
					const instance = { toolName, contentBox };
					const ctx = {
						args: {},
						toolCallId: `${toolName}-${expanded}-${isError}`,
						invalidate() {},
						lastComponent: undefined,
						state: {},
						cwd: process.cwd(),
						executionStarted: true,
						argsComplete: true,
						isPartial: false,
						expanded,
						showImages: false,
						isError,
					};
					const select = (subtype: "tool-call-renderer" | "tool-result-renderer") => {
						const renderer = owner.decorateToolRendererSelection(subtype, () => nativeRenderer, instance, []);
						assert.equal(typeof renderer, "function");
						assert.notEqual(renderer, nativeRenderer);
						return renderer as (...args: unknown[]) => { render(width: number): string[] };
					};
					const call = select("tool-call-renderer")(ctx.args, theme, ctx);
					const result = select("tool-result-renderer")(
						{ content: [{ type: "text", text: Array.from({ length: 12 }, (_, i) => `row-${i}`).join("\n") }], details: {} },
						{ expanded, isPartial: false }, theme, ctx,
					);
					const rendered = [...call.render(88), ...result.render(88)].join("\n");
					assert.match(rendered, /╭/);
					assert.match(rendered, /╰/);
					assert.match(rendered, /row-0/);
					assert.equal(rendered.includes("row-11"), expanded, "expansion must still reveal the full output");
					assert.equal(contentBox.paddingX, 0);
					assert.equal(contentBox.paddingY, 0);
					assert.equal(background("output"), "output", "boxed rendering must still remove Pi's background slab");
				}
			}
			assert.equal(owner.getDiagnostics().size, 0);
		} finally {
			owner.dispose();
		}
	});
}

test("compact-box still owns registered tools and supplies renderer-less fallbacks", () => {
	const owner = createToolDecorationOwner({ style: "compact-box" });
	const nativeReadRenderer = () => ({ render: () => ["native read"] });

	const selectedRead = owner.decorateToolRendererSelection(
		"tool-call-renderer",
		() => nativeReadRenderer,
		{ toolName: "read" },
		[],
	);
	const selectedFallback = owner.decorateToolRendererSelection(
		"tool-call-renderer",
		() => undefined,
		{ toolName: "extension_without_renderer" },
		[],
	);

	assert.equal(typeof selectedRead, "function");
	assert.notEqual(selectedRead, nativeReadRenderer);
	assert.equal(typeof selectedFallback, "function");
	owner.dispose();
});

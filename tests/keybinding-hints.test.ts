import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, beforeEach, test } from "node:test";
import ts from "typescript";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	type Component,
	type KeybindingsConfig,
} from "@earendil-works/pi-tui";
import {
	renderSpecialMessageBlock,
	setSpecialBlockTheme,
	type SpecialBlockSubtype,
} from "../extension-src/omp-theme/features/messages/special-blocks.js";
import { bashTool, resetBashTreeRegistry } from "../extension-src/omp-theme/features/tools/boxed/bash.js";
import { editTool } from "../extension-src/omp-theme/features/tools/boxed/edit.js";
import { renderFallbackResult } from "../extension-src/omp-theme/features/tools/boxed/fallback.js";
import { classifyGhCommand, parseGhOutput, renderGhCardLines } from "../extension-src/omp-theme/features/tools/boxed/gh.js";
import { getQuickEditToolConfig, quickEditTool } from "../extension-src/omp-theme/features/tools/boxed/quick-edit.js";
import { setToolsRenderConfig } from "../extension-src/omp-theme/features/tools/boxed/session-config.js";
import type { BoxedToolContext } from "../extension-src/omp-theme/features/tools/boxed/shared.js";
import { writeTool } from "../extension-src/omp-theme/features/tools/boxed/write.js";
import { renderLines, setBoxTheme, type BoxTheme } from "../extension-src/omp-theme/shared/box.js";
import {
	displayKeyHint,
	formatKeyDisplayText,
	toolExpandHint,
	toolExpandKeyText,
} from "../extension-src/omp-theme/shared/keybinding-hints.js";
import { AdaptiveDiffComponent, buildSplitRows } from "../extension-src/omp-theme/shared/split-diff.js";

const theme: BoxTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

const originalKeybindings = getKeybindings();
const definitions = {
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
} as const;

function installKeybindings(overrides: KeybindingsConfig = {}): void {
	setKeybindings(new KeybindingsManager(definitions, overrides));
}

let toolCallSequence = 0;

function toolContext(args: Record<string, unknown> = {}, expanded = false): BoxedToolContext {
	return {
		args,
		toolCallId: `keybinding-hint-test-${++toolCallSequence}`,
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

type SpecialFixture = {
	message?: { tokensBefore?: number; tokensAfter?: number; summary?: string };
	skillBlock?: { name: string; content: string };
};

function renderSpecial(subtype: SpecialBlockSubtype, fixture: SpecialFixture, expanded = false): string {
	let child: Component | undefined;
	const instance = {
		...fixture,
		expanded,
		clear() {
			child = undefined;
		},
		addChild(component: unknown) {
			child = component as Component;
		},
		removeChild() {},
		setBgFn() {},
	};
	const nativeFallback = () => {
		throw new Error(`${subtype} patch unexpectedly fell back to Pi`);
	};

	renderSpecialMessageBlock(subtype, nativeFallback, instance, []);
	assert.ok(child, `${subtype} patch should attach a component`);
	return child.render(100).join("\n");
}

function renderSkill(expanded = false): string {
	return renderSpecial(
		"native-skill-message",
		{ skillBlock: { name: "keybinding-audit", content: "A concise skill summary." } },
		expanded,
	);
}

function renderCompaction(expanded = false): string {
	return renderSpecial(
		"native-compaction-message",
		{ message: { tokensBefore: 10_000, tokensAfter: 4_000, summary: "Compacted test context." } },
		expanded,
	);
}

function renderBranch(expanded = false): string {
	return renderSpecial("native-branch-message", { message: { summary: "Prepared a test branch." } }, expanded);
}

function changedDiff(rowCount = 48): string {
	return Array.from(
		{ length: rowCount },
		(_, index) => `- ${index + 1} old value ${index + 1}\n+ ${index + 1} new value ${index + 1}`,
	).join("\n");
}

function quickEditOutput(rowCount = 48): string {
	const edits = Array.from({ length: rowCount }, (_, index) => [`- old value ${index + 1}`, `+ new value ${index + 1}`]).flat();
	return ["── diff ──", `:1-${rowCount}`, ...edits, "---"].join("\n");
}

function unifiedGitDiff(rowCount = 48): string {
	const edits = Array.from({ length: rowCount }, (_, index) => [`-old value ${index + 1}`, `+new value ${index + 1}`]).flat();
	return [
		"diff --git a/matrix.txt b/matrix.txt",
		"index 1111111..2222222 100644",
		"--- a/matrix.txt",
		"+++ b/matrix.txt",
		`@@ -1,${rowCount} +1,${rowCount} @@`,
		...edits,
	].join("\n");
}

function renderWrite(expanded = false): string {
	const args = { path: "output.txt", content: Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n") };
	const context = toolContext(args, expanded);
	const call = writeTool.call(args, theme, context);
	writeTool.result(
		{ content: [{ type: "text", text: "Wrote 8 lines to output.txt" }] },
		{ expanded, isPartial: false },
		theme,
		context,
	);
	return call.render(100).join("\n");
}

function renderFallback(expanded = false): string {
	const output = Array.from({ length: 14 }, (_, index) => `result ${index + 1}`).join("\n");
	return renderFallbackResult(
		"custom_tool",
		{ content: [{ type: "text", text: output }] },
		{ expanded, isPartial: false },
		theme,
		toolContext({}, expanded),
	)
		.render(100)
		.join("\n");
}

function renderBash(expanded = false): string {
	const args = { command: "node print-many-lines.js" };
	const context = toolContext(args, expanded);
	bashTool.call(args, theme, context);
	const output = Array.from({ length: 40 }, (_, index) => `bash line ${index + 1}`).join("\n");
	return bashTool
		.result({ content: [{ type: "text", text: output }] }, { expanded, isPartial: false }, theme, context)
		.render(100)
		.join("\n");
}

function renderEdit(expanded = false): string {
	const args = { path: "matrix.txt" };
	const context = toolContext(args, expanded);
	return editTool
		.result(
			{ content: [{ type: "text", text: "Successfully replaced text in matrix.txt." }], details: { diff: changedDiff(), path: "matrix.txt" } },
			{ expanded, isPartial: false },
			theme,
			context,
		)
		.render(120)
		.join("\n");
}

function renderQuickEdit(expanded = false): string {
	const config = getQuickEditToolConfig("quick_edit");
	assert.ok(config, "quick-edit fixture should resolve its renderer config");
	const args = { path: "matrix.txt" };
	const context = toolContext(args, expanded);
	return quickEditTool(config)
		.result(
			{ content: [{ type: "text", text: quickEditOutput() }] },
			{ expanded, isPartial: false },
			theme,
			context,
		)
		.render(120)
		.join("\n");
}

function renderGitDiff(expanded = false): string {
	const args = { command: "git diff" };
	const context = toolContext(args, expanded);
	bashTool.call(args, theme, context);
	return bashTool
		.result(
			{ content: [{ type: "text", text: unifiedGitDiff() }] },
			{ expanded, isPartial: false },
			theme,
			context,
		)
		.render(120)
		.join("\n");
}

function renderGhPreview(): string {
	const cls = classifyGhCommand("gh pr view 42");
	assert.ok(cls, "GitHub fixture command should be classified");
	const body = Array.from({ length: 9 }, (_, index) => `body line ${index + 1}`).join("\n");
	const parsed = parseGhOutput(cls, `title:\tFixture PR\nstate:\tOPEN\nnumber:\t42\n--\n${body}`);
	assert.ok(parsed, "GitHub fixture output should parse");
	return renderGhCardLines(theme, { cls, parsed }, 100).join("\n");
}

function renderAdaptiveDiff(expanded = false): string {
	const rows = buildSplitRows(changedDiff());
	return new AdaptiveDiffComponent(theme, rows, expanded ? 160 : 3).render(120).join("\n");
}

function renderLegacyLines(expanded = false): string {
	return renderLines(theme, "one\ntwo\nthree", { expanded }, { maxLines: 1 });
}

function fullHintRenderers(expanded = false): Record<string, () => string> {
	return {
		Compaction: () => renderCompaction(expanded),
		Skill: () => renderSkill(expanded),
		Branch: () => renderBranch(expanded),
		Write: () => renderWrite(expanded),
		Fallback: () => renderFallback(expanded),
		Bash: () => renderBash(expanded),
		Edit: () => renderEdit(expanded),
		"Quick Edit": () => renderQuickEdit(expanded),
		"Git diff": () => renderGitDiff(expanded),
		"Adaptive diff": () => renderAdaptiveDiff(expanded),
		"Legacy lines": () => renderLegacyLines(expanded),
	};
}

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

beforeEach(() => {
	toolCallSequence = 0;
	resetBashTreeRegistry();
	installKeybindings();
	setBoxTheme(theme);
	setSpecialBlockTheme(theme);
	setToolsRenderConfig({ maxCollapsedLines: 3, maxExpandedLines: 50, nerdFonts: false });
});

after(() => {
	setSpecialBlockTheme(undefined);
	setBoxTheme(undefined);
	setKeybindings(originalKeybindings);
});

test("display formatting matches Pi's title-cased UI convention", () => {
	assert.equal(formatKeyDisplayText("ctrl+o/alt+pageUp", "win32"), "Ctrl+O/Alt+PageUp");
	assert.equal(formatKeyDisplayText("ctrl+o/alt+pageUp", "darwin"), "Ctrl+O/Option+PageUp");
	assert.equal(toolExpandKeyText(), "Ctrl+O");
	assert.equal(toolExpandHint(), "Ctrl+O to expand");
	assert.equal(displayKeyHint("app.interrupt", "to interrupt"), "Escape to interrupt");
});

test("configured remaps and unbound actions never leave a stale shortcut", () => {
	installKeybindings({ "app.tools.expand": ["alt+x", "ctrl+shift+pageUp"] });
	assert.equal(toolExpandHint(), "Alt+X/Ctrl+Shift+PageUp to expand");

	installKeybindings({ "app.tools.expand": [] });
	assert.equal(toolExpandKeyText(), "");
	assert.equal(toolExpandHint(), "");
});

test("every changed collapsed surface renders the default display key", () => {
	for (const [name, render] of Object.entries(fullHintRenderers())) {
		assert.match(render(), /Ctrl\+O to expand/, `${name} should render the default expansion hint`);
	}
	assert.match(renderGhPreview(), /more lines · Ctrl\+O/, "GitHub's narrow preview should render the compact key");
});

test("every changed collapsed surface follows a configured remap", () => {
	installKeybindings({ "app.tools.expand": "alt+x" });
	for (const [name, render] of Object.entries(fullHintRenderers())) {
		const output = render();
		assert.match(output, /Alt\+X to expand/, `${name} should render the remapped expansion hint`);
		assert.doesNotMatch(output, /Ctrl\+O|ctrl\+o/, `${name} should not retain the default binding`);
	}
	const gh = renderGhPreview();
	assert.match(gh, /more lines · Alt\+X/);
	assert.doesNotMatch(gh, /Ctrl\+O|ctrl\+o/);
});

test("every changed collapsed surface omits the affordance when expansion is unbound", () => {
	installKeybindings({ "app.tools.expand": [] });
	for (const [name, render] of Object.entries(fullHintRenderers())) {
		const output = render();
		assert.doesNotMatch(output, /to expand/, `${name} should hide an unbound action`);
		assert.doesNotMatch(output, /Ctrl\+O|Alt\+X|ctrl\+o/, `${name} should not invent a binding`);
	}
	assert.doesNotMatch(renderGhPreview(), /Ctrl\+O|Alt\+X|ctrl\+o/);
});

test("expanded surfaces do not keep a stale expansion affordance", () => {
	for (const [name, render] of Object.entries(fullHintRenderers(true))) {
		assert.doesNotMatch(render(), /to expand|Ctrl\+O|ctrl\+o/, `${name} should be hint-free when expanded`);
	}
});

test("extension source cannot bypass the configured display-key helper", () => {
	const sourceRoot = resolve("extension-src/omp-theme");
	const offenders = sourceFiles(sourceRoot).filter((file) => {
		const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
		let bypassed = false;
		const visit = (node: ts.Node): void => {
			if (
				(ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
				/(?:Ctrl\+[Oo]|ctrl\+o)/.test(node.text)
			) {
				bypassed = true;
			}
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "keyText") {
				bypassed = true;
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		return bypassed;
	});
	assert.deepEqual(offenders, []);
});

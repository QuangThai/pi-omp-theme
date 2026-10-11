// Diff rows as Pi and git hand them over: Pi's `...` skip marker, numbering
// across skips and hunks, and what Ctrl+O can reveal.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AdaptiveDiffComponent, buildSplitRows } from "../extension-src/omp-theme/shared/split-diff.js";
import { goldenTheme, plainLine } from "./support/golden.js";

type Row = { kind: string; left?: { lineNumber: string; line: string }; right?: { lineNumber: string; line: string }; hidden?: number };

const rowsOf = (diff: string) => buildSplitRows(diff) as unknown as Row[];
const context = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, index) => ` ${String(from + index).padStart(2)} row ${from + index}`);
/** Pi's marker (`edit-diff`): a space, the blank number column, then ` ...`. */
const SKIP = ` ${"".padStart(2, " ")} ...`;

function paint(diff: string, expanded: boolean): { lines: string[]; canExpand: boolean } {
	const view = new AdaptiveDiffComponent(goldenTheme, buildSplitRows(diff), expanded ? 160 : 36, undefined, {
		expanded,
		expandedMaxRows: 160,
	});
	return { lines: view.render(60).map((line) => plainLine(line).trimEnd()), canExpand: view.hasCollapsed() };
}

test("Pi's trailing skip marker is a gap, not a numbered line", () => {
	const diff = [...context(1, 4), "- 5 row 5", "+ 5 ROW 5", ...context(6, 9), SKIP].join("\n");
	const rows = rowsOf(diff);
	assert.equal(rows.at(-1)?.kind, "skip");
	assert.equal(rows.at(-1)?.hidden, undefined, "nothing after it tells how many");
	assert.equal(rows.filter((row) => row.kind === "context").length, 8);
	const collapsed = paint(diff, false);
	assert.ok(!collapsed.lines.some((line) => /\b10\b/.test(line)), "no invented line 10");
	assert.equal(collapsed.lines.at(-1)?.trim(), "⋯ unchanged lines hidden");
	assert.equal(collapsed.canExpand, false, "expanding would show the same rows");
	assert.deepEqual(paint(diff, true).lines, collapsed.lines);
});

test("a skip between two changes counts the lines it hides", () => {
	const diff = [...context(2, 4), "- 5 x", "+ 5 X", ...context(6, 9), SKIP, ...context(20, 23), "- 24 y", "+ 24 Y", ...context(25, 26)].join(
		"\n",
	);
	const skip = rowsOf(diff).find((row) => row.kind === "skip");
	assert.equal(skip?.hidden, 10);
	assert.ok(paint(diff, true).lines.some((line) => line.trim() === "⋯ 10 unchanged lines hidden"));
});

test("a skip opening the diff hides the lines above the first one shown", () => {
	const rows = rowsOf([SKIP, ...context(7, 9), "- 10 x", "+ 10 X"].join("\n"));
	assert.equal(rows[0]?.kind, "skip");
	assert.equal(rows[0]?.hidden, 6);
});

test("new-side numbers follow the old side across a skip and across git hunks", () => {
	// Two lines added before the skip: everything after it sits two lines lower.
	const piRows = rowsOf([" 1 a", "+ 2 b", "+ 3 c", " 2 d", SKIP, " 10 j"].join("\n"));
	const resumed = piRows.find((row) => row.left?.lineNumber === "10");
	assert.equal(resumed?.right?.lineNumber, "12");
	// git diff bodies arrive numbered with the hunk headers stripped (git.ts).
	const gitRows = rowsOf([" 1 a", "- 2 b", "+ 2 B", "+ 3 C", " 3 c", " 10 j", " 11 k"].join("\n"));
	assert.equal(gitRows.find((row) => row.left?.lineNumber === "3")?.right?.lineNumber, "4");
	assert.equal(gitRows.find((row) => row.left?.lineNumber === "10")?.right?.lineNumber, "11");
	assert.equal(gitRows.find((row) => row.left?.lineNumber === "11")?.right?.lineNumber, "12");
});

test("new-side numbers stay aligned when a change opens the diff or follows a skip", () => {
	// Line 1 removed: old line 2 is new line 1.
	assert.equal(rowsOf(["- 1 x", " 2 y"].join("\n")).find((row) => row.left?.lineNumber === "2")?.right?.lineNumber, "1");
	// Line 1 added: old line 1 is new line 2.
	assert.equal(rowsOf(["+ 1 x", " 1 y"].join("\n")).find((row) => row.left?.lineNumber === "1")?.right?.lineNumber, "2");
	// Two lines up before the skip, one removed after it: old 21 is new 22.
	const afterSkip = rowsOf([" 1 a", "+ 2 b", "+ 3 c", " 2 d", SKIP, "- 20 x", " 21 y"].join("\n"));
	assert.equal(afterSkip.find((row) => row.left?.lineNumber === "21")?.right?.lineNumber, "22");
	// One added right after the skip: old 22 is new 25.
	const addedAfterSkip = rowsOf([" 1 a", "+ 2 b", "+ 3 c", " 2 d", SKIP, "+ 24 X", " 22 y"].join("\n"));
	assert.equal(addedAfterSkip.find((row) => row.left?.lineNumber === "22")?.right?.lineNumber, "25");
});

test("a line that reads `...` is content wherever it is not Pi's marker", () => {
	const numbered = rowsOf([" 4 a", " 5 ...", "- 6 b", "+ 6 B"].join("\n"));
	assert.equal(numbered.find((row) => row.left?.lineNumber === "5")?.left?.line, "...");
	assert.ok(!numbered.some((row) => row.kind === "skip"));
	const unified = rowsOf(["@@ -1,3 +1,3 @@", " a", "   ...", "-b", "+B"].join("\n"));
	assert.ok(!unified.some((row) => row.kind === "skip"), "a unified diff has no skip markers");
});

test("folded context is what Ctrl+O reveals", () => {
	const diff = [...context(1, 4), "- 5 row 5", "+ 5 ROW 5", ...context(6, 14)].join("\n");
	const collapsed = paint(diff, false);
	const expanded = paint(diff, true);
	assert.equal(collapsed.canExpand, true);
	assert.ok(collapsed.lines.some((line) => line.includes("unchanged lines hidden")));
	assert.ok(!expanded.lines.some((line) => line.includes("hidden")), "expanded paints every row");
	assert.ok(expanded.lines.some((line) => line.includes("row 14")));
});

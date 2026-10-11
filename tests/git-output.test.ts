// git output as Pi's bash tool hands it over, stderr notices included.

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGitCommand, parseGitOutput } from "../extension-src/omp-theme/features/tools/boxed/git.js";

const DIFF = [
	"diff --git a/README.md b/README.md",
	"index 6d6940e..f894627 100644",
	"--- a/README.md",
	"+++ b/README.md",
	"@@ -1,3 +1,3 @@",
	" # Fixture",
	" ",
	"-line two",
	"+line 2",
].join("\n");

/** What Git for Windows prints to stderr with `core.autocrlf` on (current and older wording). */
const NOTICES = [
	"warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it",
	"warning: LF will be replaced by CRLF in README.md.",
	"The file will have its original line endings in your working directory",
	"warning: CRLF will be replaced by LF in notes.txt.",
];

function parse(command: string, output: string) {
	const cls = classifyGitCommand(command);
	assert.ok(cls, `${command} is a git semantic command`);
	return parseGitOutput(cls, output);
}

test("autocrlf notices do not push a git diff back to raw output", () => {
	const clean = parse("git diff", DIFF);
	assert.equal(clean?.kind, "diff");
	assert.deepEqual(parse("git diff", `${NOTICES[0]}\n${DIFF}`), clean);
	assert.deepEqual(parse("git diff", [NOTICES[1], NOTICES[2], DIFF, NOTICES[3]].join("\n")), clean);
	assert.deepEqual(parse("git diff", `${NOTICES[0]}\r\n${DIFF}`), clean, "a CRLF-terminated notice too");
});

test("autocrlf notices do not push git status back to raw output", () => {
	const status = ["On branch main", "Changes not staged for commit:", "\tmodified:   README.md"].join("\n");
	const clean = parse("git status", status);
	assert.equal(clean?.kind, "status");
	assert.deepEqual(parse("git status", `${NOTICES[0]}\n${status}`), clean);
});

test("other warnings still fail closed", () => {
	assert.equal(parse("git diff", `warning: refname 'HEAD' is ambiguous.\n${DIFF}`), null);
});

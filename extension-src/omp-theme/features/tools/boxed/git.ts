// Git semantic view renderer (Phase 8A).
//
// Bash `git status` / `git diff --stat` / short `git log` results render as a
// boxless compact card in the call panel, mirroring the ls/find/grep tree path
// (see bash.ts, which owns the per-call registry and raw-shell fallback).
//
// Every parser is fail-closed (ADR 0005): on any ambiguity it returns null and
// the boxed command/response shell renders the raw output unchanged. Only
// values git's output actually carries are shown — `git diff --stat` bars are
// scaled, so per-file rows show the exact `| N` change count instead of a
// guessed +/− split, and the exact +/− totals come from the summary line.

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	type BoxTheme,
	boxBlankLine,
	boxLabeledBorder,
	boxWidth,
	dimLine,
	renderBoxedToolResult,
	dropOmittedLines,
} from "../../../shared/box.js";
import { formatElapsedMs } from "../../../shared/elapsed.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";
import { AdaptiveDiffComponent, buildSplitRows } from "../../../shared/split-diff.js";
import { parseSimpleBashCommand } from "./command-shape.js";
import { pluralForm, TREE_INDENT } from "./output-tree.js";
import { getStateElapsedMs, getToolsRenderConfig } from "./session-config.js";
import type { BoxedToolContext } from "./shared.js";

// ── Classification ──────────────────────────────────────────────────────────

/** State-change git commands that render a boxless summary card (Phase 8C):
 *  `commit`/`push`/`pull`/`fetch` (8C-1) plus `switch`/`checkout`/`add`/
 *  `restore`/`reset`/`merge`/`rebase` (8C-2). Each surfaces a different shape;
 *  the parsers are fail-closed and the renderer switches on `command`. */
export type GitActionCommand =
	| "commit"
	| "push"
	| "pull"
	| "fetch"
	| "switch"
	| "checkout"
	| "add"
	| "restore"
	| "reset"
	| "merge"
	| "rebase";

export type GitSemanticClass =
	| { readonly kind: "status"; readonly short: boolean }
	| { readonly kind: "diff-stat" }
	| { readonly kind: "log" }
	| { readonly kind: "show-stat" }
	| { readonly kind: "diff"; readonly show: boolean }
	| { readonly kind: "action"; readonly command: GitActionCommand };

const GIT_SHORT_STATUS_FLAGS = new Set(["-s", "--short", "--porcelain"]);
const GIT_DIFF_FORMAT_REJECT = new Set([
	"-p",
	"--patch",
	"--numstat",
	"--shortstat",
	"--dirstat",
	"--summary",
	"--name-only",
	"--name-status",
	"--raw",
	"--word-diff",
]);
/** Flags that switch `git diff` patch output to a non-line-based or summary
 *  shape we cannot feed to the adaptive diff component (ADR 0005: fail-closed). */
const GIT_DIFF_PATCH_REJECT = new Set([
	"--numstat",
	"--shortstat",
	"--dirstat",
	"--summary",
	"--name-only",
	"--name-status",
	"--raw",
	"--word-diff",
	"--binary",
	"--no-patch",
	"-s",
	"--patch-with-stat",
	"--patch-with-raw",
]);
/** `git show` (plain patch output) additionally rejects `--stat` (commit + stat
 *  is a different shape) and commit-format flags that change the header. */
const GIT_SHOW_REJECT = new Set([...GIT_DIFF_PATCH_REJECT, "--stat", "--oneline", "--format", "--pretty"]);
/** `git show --stat` (commit header + stat block) rejects any other
 *  format-changing flag that would alter that shape: `-p`/`--patch` append a
 *  patch, the rest are alternate stat/format/name shapes (ADR 0005). */
const GIT_SHOW_STAT_REJECT = new Set([...GIT_DIFF_PATCH_REJECT, "-p", "--patch", "--oneline"]);
const GIT_LOG_FORMAT_REJECT = new Set([
	"-p",
	"--patch",
	"--stat",
	"--numstat",
	"--shortstat",
	"--dirstat",
	"--summary",
	"--name-only",
	"--name-status",
	"--raw",
	"--graph",
	"--format",
	"--pretty",
	"--word-diff",
	"--color",
	"--show-signature",
]);

/** `git commit` flags that change the output shape: `-v` appends the diff,
 *  `-p`/`--patch` open an editor with a patch, `-i`/`--interactive` are
 *  interactive, `--porcelain`/`--dry-run` swap to a different report
 *  (ADR 0005: fail-closed). */
const GIT_COMMIT_REJECT = new Set([
	"-v",
	"--verbose",
	"-p",
	"--patch",
	"-i",
	"--interactive",
	"--porcelain",
	"--dry-run",
]);
/** `git push` flags that change the output shape: `--porcelain` is machine
 *  format, `-v`/`--verbose` add `Pushing to`/`= [up to date]` lines, and
 *  `--dry-run` reports what would happen without doing it (ADR 0005). */
const GIT_PUSH_REJECT = new Set(["--porcelain", "-v", "--verbose", "--dry-run", "-n"]);
/** `git pull` flags that change the output shape: `-v`/`--verbose` add fetch
 *  chatter, `--rebase` produces a rebase-shaped report instead of a merge
 *  summary (ADR 0005). */
const GIT_PULL_REJECT = new Set(["-v", "--verbose", "--rebase"]);
/** `git fetch` flags that change the output shape: `-v`/`--verbose` add
 *  `= [up to date]` per-ref chatter and `--dry-run` reports without fetching
 *  (ADR 0005). */
const GIT_FETCH_REJECT = new Set(["-v", "--verbose", "--dry-run"]);
/** `git switch`/`checkout` flags that change the output shape: `-p`/`--patch`
 *  open an interactive hunk picker, `-i`/`--interactive` is the classic checkout
 *  TUI, and `--orphan` swaps the `Switched to …` line for a creation report
 *  (ADR 0005). `-m` (merge on switch) is not rejected here — its clean output
 *  still parses, and the merge-rows shape fails closed in the parser. */
const GIT_SWITCH_REJECT = new Set(["-p", "--patch", "-i", "--interactive", "--orphan"]);
/** `git add`/`restore` flags that change the output shape: `-p`/`--patch` and
 *  `-i`/`--interactive` open hunk/TUI pickers, and `-v`/`--verbose` list every
 *  staged path instead of staying silent (ADR 0005). */
const GIT_ADD_REJECT = new Set(["-p", "--patch", "-i", "--interactive", "-v", "--verbose"]);
/** `git reset` flags that change the output shape: `-p`/`--patch` opens an
 *  interactive hunk picker. The mode flags (`--soft`/`--mixed`/`--hard`) are
 *  the shapes the parser reads, so they stay classified (ADR 0005). */
const GIT_RESET_REJECT = new Set(["-p", "--patch"]);
/** `git merge` flags that change the output shape: `-v`/`--verbose` append the
 *  per-file diff. `--squash`/`--abort`/`--continue` produce different reports
 *  that fail closed in the parser (ADR 0005). */
const GIT_MERGE_REJECT = new Set(["-v", "--verbose"]);
/** `git rebase` flags that change the output shape entirely: `-i`/
 *  `--interactive` opens the commit-list editor and `-x`/`--exec` runs a shell
 *  command per commit, swapping the single success line for a different report
 *  (ADR 0005). */
const GIT_REBASE_REJECT = new Set(["-i", "--interactive", "-x", "--exec"]);

/**
 * Classify a bash command for git semantic rendering, or null to keep the
 * boxed shell. Only porcelain commands with simple output shapes are eligible
 * (`git status`, `git diff --stat`, `git log`); `git -C …`, aliases, plumbing
 * (`cat-file`, `rev-parse`, `for-each-ref`), format-changing flags, and any
 * pipe/redirect fall back raw (ADR 0005).
 */
export function classifyGitCommand(command: string): GitSemanticClass | null {
	const shape = parseSimpleBashCommand(command);
	if (!shape) return null;
	const rest = shape.tokens;
	if ((rest[0] ?? "").split("/").pop() !== "git") return null;
	const args = rest.slice(1);
	if (args.length === 0) return null;
	const sub = args[0] ?? "";

	if (sub === "status") {
		// `-z`/`--porcelain=v2` switch the output format entirely; the v1 short
		// parser cannot read them.
		if (args.some((arg) => arg === "-z" || arg === "--null" || arg.startsWith("--porcelain=v2"))) return null;
		const short =
			args.some((arg) => GIT_SHORT_STATUS_FLAGS.has(arg) || /^-[sS][a-zA-Z]*$/.test(arg)) ||
			args.some((arg) => arg.startsWith("--porcelain=v1"));
		return { kind: "status", short };
	}
	if (sub === "diff") {
		const hasStat = args.some((arg) => arg === "--stat" || arg.startsWith("--stat="));
		if (hasStat) {
			if (
				args.some(
					(arg) => GIT_DIFF_FORMAT_REJECT.has(arg) || arg.startsWith("--format=") || arg.startsWith("--pretty="),
				)
			) {
				return null;
			}
			return { kind: "diff-stat" };
		}
		// Plain `git diff` (patch output) renders as a boxed adaptive diff. Reject
		// format-changing flags; `-p`/`--patch` is the default patch shape and stays.
		if (args.some((arg) => GIT_DIFF_PATCH_REJECT.has(arg) || arg.startsWith("--word-diff="))) {
			return null;
		}
		return { kind: "diff", show: false };
	}
	if (sub === "show") {
		const hasStat = args.some((arg) => arg === "--stat" || arg.startsWith("--stat="));
		if (hasStat) {
			// `git show --stat` = commit header + stat block → a diff-stat-shaped
			// card. Reject any other format-changing flag (a patch, numstat,
			// name-only, format override, …). `-p`/`--patch` append a patch; combined
			// short clusters containing `p` (e.g. `-sp`) do too.
			if (
				args.some(
					(arg) =>
						GIT_SHOW_STAT_REJECT.has(arg) ||
						/^-[A-Za-z]*p[A-Za-z]*$/.test(arg) ||
						arg.startsWith("--word-diff=") ||
						arg.startsWith("--format=") ||
						arg.startsWith("--pretty="),
				)
			) {
				return null;
			}
			return { kind: "show-stat" };
		}
		// Plain `git show` (patch output) renders as a boxed adaptive diff. Reject
		// format-changing flags; `-p`/`--patch` is the default patch shape and stays.
		if (
			args.some(
				(arg) =>
					GIT_SHOW_REJECT.has(arg) ||
					arg.startsWith("--word-diff=") ||
					arg.startsWith("--format=") ||
					arg.startsWith("--pretty="),
			)
		) {
			return null;
		}
		return { kind: "diff", show: true };
	}
	if (sub === "log") {
		if (
			args.some((arg) => GIT_LOG_FORMAT_REJECT.has(arg) || arg.startsWith("--format=") || arg.startsWith("--pretty="))
		) {
			return null;
		}
		return { kind: "log" };
	}
	if (sub === "commit") {
		if (args.some((arg) => GIT_COMMIT_REJECT.has(arg) || /^-[A-Za-z]*[vpi][A-Za-z]*$/.test(arg))) return null;
		return { kind: "action", command: "commit" };
	}
	if (sub === "push") {
		if (args.some((arg) => GIT_PUSH_REJECT.has(arg) || /^-[A-Za-z]*[vn][A-Za-z]*$/.test(arg))) return null;
		return { kind: "action", command: "push" };
	}
	if (sub === "pull") {
		if (args.some((arg) => GIT_PULL_REJECT.has(arg) || /^-[A-Za-z]*v[A-Za-z]*$/.test(arg))) return null;
		return { kind: "action", command: "pull" };
	}
	if (sub === "fetch") {
		if (args.some((arg) => GIT_FETCH_REJECT.has(arg) || /^-[A-Za-z]*v[A-Za-z]*$/.test(arg))) return null;
		return { kind: "action", command: "fetch" };
	}
	if (sub === "switch" || sub === "checkout") {
		// Reject interactive patch/TUI and orphan; `-m` stays (clean output parses,
		// merge-rows shape fails closed). Short clusters containing `p`/`i` cover
		// `-p`/`-i` bundled with other flags.
		if (args.some((arg) => GIT_SWITCH_REJECT.has(arg) || /^-[A-Za-z]*[pi][A-Za-z]*$/.test(arg))) return null;
		return { kind: "action", command: sub };
	}
	if (sub === "add" || sub === "restore") {
		// Reject interactive patch/TUI and verbose; `-A`/`-u`/`-f`/`-S`/`-W` stay.
		if (args.some((arg) => GIT_ADD_REJECT.has(arg) || /^-[A-Za-z]*[piv][A-Za-z]*$/.test(arg))) return null;
		return { kind: "action", command: sub };
	}
	if (sub === "reset") {
		// Reject interactive patch; the mode flags (`--soft`/`--mixed`/`--hard`)
		// are the shapes the parser reads.
		if (args.some((arg) => GIT_RESET_REJECT.has(arg) || /^-[A-Za-z]*p[A-Za-z]*$/.test(arg))) return null;
		return { kind: "action", command: "reset" };
	}
	if (sub === "merge") {
		// Reject verbose; `--squash`/`--abort`/`--continue` fail closed in the parser.
		if (args.some((arg) => GIT_MERGE_REJECT.has(arg) || /^-[A-Za-z]*v[A-Za-z]*$/.test(arg))) return null;
		return { kind: "action", command: "merge" };
	}
	if (sub === "rebase") {
		// Reject interactive/exec; `--abort`/`--continue`/`--skip` fail closed.
		if (
			args.some(
				(arg) => GIT_REBASE_REJECT.has(arg) || arg.startsWith("--exec=") || /^-[A-Za-z]*[ix][A-Za-z]*$/.test(arg),
			)
		)
			return null;
		return { kind: "action", command: "rebase" };
	}
	return null;
}

// ── Parsed shapes ───────────────────────────────────────────────────────────

export interface GitStatusFile {
	/** Index (staged) status char: `M`/`A`/`D`/`R`/`C`/`T`/`U`/`?`/`!` or space. */
	readonly x: string;
	/** Worktree (unstaged) status char, or space. */
	readonly y: string;
	/** Display path; renames carry `old -> new`. */
	readonly path: string;
}

export interface GitStatusParsed {
	readonly kind: "status";
	readonly branch?: string;
	readonly ahead?: number;
	readonly behind?: number;
	readonly diverged?: boolean;
	readonly files: readonly GitStatusFile[];
}

export interface GitDiffStatFile {
	readonly path: string;
	/** Exact changed-line count from the `| N` column (absent for binary files). */
	readonly changes?: number;
	readonly binary?: boolean;
}

/** Per-file stat summary shared by `git diff --stat` and `git show --stat`
 *  (the show-stat card adds a commit header on top of these rows). */
interface DiffStatSummary {
	readonly files: readonly GitDiffStatFile[];
	readonly filesChanged?: number;
	readonly insertions?: number;
	readonly deletions?: number;
}

export interface GitDiffStatParsed extends DiffStatSummary {
	readonly kind: "diff-stat";
}

/** `git show --stat`: full-format commit header (hash + first message-line
 *  subject) followed by the same per-file stat block as `git diff --stat`. */
export interface GitShowStatParsed extends DiffStatSummary {
	readonly kind: "show-stat";
	/** Full commit hash from the `commit <hash>` header (shortened for display). */
	readonly hash: string;
	readonly subject: string;
}

export interface GitLogCommit {
	readonly hash: string;
	readonly refs?: string;
	readonly subject: string;
}

export interface GitLogParsed {
	readonly kind: "log";
	readonly commits: readonly GitLogCommit[];
}

export interface GitDiffFile {
	/** Display path (renames carry `old => new`). */
	readonly path: string;
	readonly status?: "added" | "deleted" | "renamed" | "modified";
	readonly binary?: boolean;
	readonly additions: number;
	readonly removals: number;
	/** Normalized edit-format diff body for `AdaptiveDiffComponent` (empty for binary). */
	readonly body: string;
}

export interface GitDiffParsed {
	readonly kind: "diff";
	readonly show: boolean;
	/** `git show`: short commit hash from the commit header. */
	readonly hash?: string;
	/** `git show`: first message-line subject. */
	readonly subject?: string;
	readonly files: readonly GitDiffFile[];
}

/** `git commit` / `push` / `pull` / `fetch` / `switch` / `checkout` / `add` /
 *  `restore` / `reset` / `merge` / `rebase` state-change results. Each command
 *  surfaces a different subset of fields; the renderer switches on `command`.
 *  Stat summaries (commit / pull fast-forward / merge) reuse the diff-stat
 *  shape so the same `N files changed · +A -D` line and `├─/└─` rows render
 *  verbatim. */
export interface GitActionParsed extends DiffStatSummary {
	readonly kind: "action";
	readonly command: GitActionCommand;
	/** `git commit` success: branch from `[<branch> <hash>]` (status line owns
	 *  the `⎇ main` glyph, so this is not rendered). */
	readonly branch?: string;
	/** `git commit` success: short hash from `[<branch> <hash>]`; also
	 *  `git reset --hard`: the `HEAD is now at <hash>` target. */
	readonly hash?: string;
	/** `git commit` success: commit subject line; also `git reset --hard`:
	 *  the `HEAD is now at <hash> <subject>` subject. */
	readonly subject?: string;
	/** `git push` / `git fetch`: remote URL/path from the `To `/`From ` line. */
	readonly remote?: string;
	/** `git push` / `git fetch`: normalized ref-update rows (alignment spaces
	 *  collapsed to single spaces). */
	readonly refs?: readonly string[];
	/** Informational status line: `nothing to commit`, `Everything up-to-date`,
	 *  `Already up to date.`, `Fast-forward`, `no new refs`, `Merge made by the
	 *  'ort' strategy.`, or `completed, no output` for silent success
	 *  (`add`/`restore`/`reset --soft`/`checkout -- <file>`). */
	readonly status?: string;
	/** `git pull` / `git merge` fast-forward: the `Updating <a>..<b>` range. */
	readonly range?: string;
	/** `git switch -c` / `git checkout -b`: the branch was created, not just
	 *  switched to (controls the confirmation row wording). */
	readonly created?: boolean;
	/** `git reset` (mixed): status-marker + path rows from the
	 *  `Unstaged changes after reset:` block (marker in `x`, `y` is space). */
	readonly resetFiles?: readonly GitStatusFile[];
}

export type GitParsedSemantic =
	| GitStatusParsed
	| GitDiffStatParsed
	| GitShowStatParsed
	| GitLogParsed
	| GitDiffParsed
	| GitActionParsed;

// ── git status parsers ──────────────────────────────────────────────────────

/** Long-form section verbs → `(index, worktree)` status chars. */
const LONG_STATUS_VERBS: Readonly<Record<string, readonly [string, string]>> = {
	"new file": ["A", " "],
	modified: ["M", " "],
	deleted: ["D", " "],
	renamed: ["R", " "],
	copied: ["C", " "],
	typechange: ["T", " "],
	"both modified": ["U", "U"],
	"both added": ["A", "A"],
	"both deleted": ["D", "D"],
	"added by us": ["A", "U"],
	"added by them": ["U", "A"],
	"deleted by us": ["D", "U"],
	"deleted by them": ["U", "D"],
	unmerged: ["U", "U"],
};

type LongSection = "staged" | "unstaged" | "untracked" | "ignored" | "unmerged" | null;

const LONG_SECTION_HEADERS: Readonly<Record<string, LongSection>> = {
	"Changes to be committed:": "staged",
	"Changes not staged for commit:": "unstaged",
	"Untracked files:": "untracked",
	"Ignored files:": "ignored",
	"Unmerged paths:": "unmerged",
};

const LONG_STATUS_ENTRY = /^([a-z ]+?):\s+(.+)$/;
const LONG_BRANCH = /^On branch (.+)$/;
const LONG_DETACHED = /^HEAD detached at ([0-9a-f]+)/;
const LONG_AHEAD = /^Your branch is ahead of '(.*)' by (\d+) commit/;
const LONG_BEHIND = /^Your branch is behind '(.*)' by (\d+) commit/;
const LONG_DIVERGED = /^Your branch and '(.*)' have diverged/;
const LONG_DIVERGED_COUNTS = /^and have (\d+) and (\d+) different commits each/;

function parseGitStatusLong(text: string): GitStatusParsed | null {
	const files: GitStatusFile[] = [];
	let branch: string | undefined;
	let ahead: number | undefined;
	let behind: number | undefined;
	let diverged = false;
	let section: LongSection = null;
	let divergedNext = false;
	let sawContent = false;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") continue;

		const branchMatch = LONG_BRANCH.exec(line);
		if (branchMatch) {
			sawContent = true;
			branch = branchMatch[1];
			continue;
		}
		const detached = LONG_DETACHED.exec(line);
		if (detached) {
			sawContent = true;
			branch = detached[1];
			continue;
		}
		const aheadMatch = LONG_AHEAD.exec(line);
		if (aheadMatch) {
			sawContent = true;
			ahead = Number(aheadMatch[2]);
			continue;
		}
		const behindMatch = LONG_BEHIND.exec(line);
		if (behindMatch) {
			sawContent = true;
			behind = Number(behindMatch[2]);
			continue;
		}
		const divergedMatch = LONG_DIVERGED.exec(line);
		if (divergedMatch) {
			sawContent = true;
			diverged = true;
			divergedNext = true;
			continue;
		}
		if (divergedNext) {
			const counts = LONG_DIVERGED_COUNTS.exec(line);
			if (!counts) return null;
			sawContent = true;
			ahead = Number(counts[1]);
			behind = Number(counts[2]);
			divergedNext = false;
			continue;
		}

		const sectionHeader = LONG_SECTION_HEADERS[line];
		if (sectionHeader !== undefined) {
			sawContent = true;
			section = sectionHeader;
			continue;
		}
		// Hint lines (`  (use "git add …" …)`, `  (fix conflicts …)`) and
		// clean/empty-state markers.
		if (/^\s{2}\(/.test(line)) continue;
		if (
			line.startsWith("no changes added to commit") ||
			line === "nothing to commit, working tree clean" ||
			line === "You have unmerged paths." ||
			line === "No commits yet"
		) {
			sawContent = true;
			continue;
		}
		if (line.startsWith("Your branch is up to date with ")) {
			sawContent = true;
			continue;
		}

		if (line.startsWith("\t")) {
			const body = line.slice(1).trimStart();
			if (!body) return null;
			// Untracked/ignored entries are bare paths.
			if (section === "untracked" || section === "ignored") {
				const mark = section === "untracked" ? "?" : "!";
				sawContent = true;
				files.push({ x: mark, y: mark, path: body });
				continue;
			}
			const verbMatch = LONG_STATUS_ENTRY.exec(body);
			if (!verbMatch) return null;
			const xy = LONG_STATUS_VERBS[verbMatch[1] ?? ""];
			if (!xy) return null; // unknown verb (localized git, unexpected section)
			const path = (verbMatch[2] ?? "").trim();
			if (!path) return null;
			sawContent = true;
			if (section === "staged") files.push({ x: xy[0], y: " ", path });
			else if (section === "unstaged") files.push({ x: " ", y: xy[0], path });
			else files.push({ x: xy[0], y: xy[1], path });
			continue;
		}

		return null; // unrecognized non-tab line → localized/hostile output
	}
	if (divergedNext) return null;
	if (!sawContent) return null;
	return {
		kind: "status",
		files,
		...(branch !== undefined ? { branch } : {}),
		...(ahead !== undefined ? { ahead } : {}),
		...(behind !== undefined ? { behind } : {}),
		...(diverged ? { diverged: true } : {}),
	};
}

const SHORT_STATUS_BRANCH = /^## (.+)$/;
const SHORT_STATUS_BRANCH_DETAIL = /^(.+?)(?:\.\.\.(.+?))?(?: \[([^\]]+)\])?$/;
const SHORT_STATUS_FILE = /^([ MADRCU?!])([ MADRCU?!]) (.*)$/;

function parseGitStatusShort(text: string): GitStatusParsed | null {
	if (text.includes("\u0000")) return null; // `-z` NUL-separated format
	const files: GitStatusFile[] = [];
	let branch: string | undefined;
	let ahead: number | undefined;
	let behind: number | undefined;
	let diverged = false;
	let sawStatus = false;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") continue;

		const branchLine = SHORT_STATUS_BRANCH.exec(line);
		if (branchLine) {
			sawStatus = true;
			const detail = SHORT_STATUS_BRANCH_DETAIL.exec(branchLine[1] ?? "");
			if (detail) {
				branch = detail[1];
				const bracket = detail[3];
				if (bracket) {
					const aheadM = /ahead (\d+)/.exec(bracket);
					const behindM = /behind (\d+)/.exec(bracket);
					if (aheadM) ahead = Number(aheadM[1]);
					if (behindM) behind = Number(behindM[1]);
					if (aheadM && behindM) diverged = true;
					// `[gone]` and other bracket states carry no counts — ignored.
				}
			}
			continue;
		}

		const fileMatch = SHORT_STATUS_FILE.exec(line);
		if (!fileMatch) return null; // unrecognized line → hostile output
		sawStatus = true;
		files.push({ x: fileMatch[1] ?? "", y: fileMatch[2] ?? "", path: fileMatch[3] ?? "" });
	}

	if (!sawStatus && text.trim() !== "") return null;
	return {
		kind: "status",
		files,
		...(branch !== undefined ? { branch } : {}),
		...(ahead !== undefined ? { ahead } : {}),
		...(behind !== undefined ? { behind } : {}),
		...(diverged ? { diverged: true } : {}),
	};
}

function parseGitStatus(cls: GitSemanticClass, text: string): GitStatusParsed | null {
	if (cls.kind !== "status") return null;
	return cls.short ? parseGitStatusShort(text) : parseGitStatusLong(text);
}

// ── git diff --stat parser ──────────────────────────────────────────────────

const DIFF_STAT_SUMMARY = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/;
const DIFF_STAT_FILE = /^(.*)\s+\|\s+(\d+)\s*.*$/;
const DIFF_STAT_BINARY = /^(.*)\s+\|\s+Bin\s+.*$/;

function parseGitDiffStat(text: string): GitDiffStatParsed | null {
	const files: GitDiffStatFile[] = [];
	let filesChanged: number | undefined;
	let insertions: number | undefined;
	let deletions: number | undefined;
	let sawLine = false;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") continue;
		sawLine = true;

		const summary = DIFF_STAT_SUMMARY.exec(line);
		if (summary) {
			filesChanged = Number(summary[1]);
			if (summary[2] !== undefined) insertions = Number(summary[2]);
			if (summary[3] !== undefined) deletions = Number(summary[3]);
			continue;
		}

		const binary = DIFF_STAT_BINARY.exec(line);
		if (binary) {
			const path = (binary[1] ?? "").trim();
			if (!path) return null;
			files.push({ path, binary: true });
			continue;
		}

		const file = DIFF_STAT_FILE.exec(line);
		if (file) {
			const path = (file[1] ?? "").trim();
			if (!path) return null;
			files.push({ path, changes: Number(file[2]) });
			continue;
		}

		return null; // unrecognized line (--numstat/-z output, stat=width oddities)
	}

	if (!sawLine) return { kind: "diff-stat", files }; // empty diff → no changes
	if (files.length === 0 && filesChanged === undefined) return null;
	return {
		kind: "diff-stat",
		files,
		...(filesChanged !== undefined ? { filesChanged } : {}),
		...(insertions !== undefined ? { insertions } : {}),
		...(deletions !== undefined ? { deletions } : {}),
	};
}

// ── git log parser ──────────────────────────────────────────────────────────

const LOG_COMMIT_LINE = /^commit ([0-9a-f]{4,40})(?: \((.*)\))?$/;
const LOG_ONELINE = /^([0-9a-f]{4,40})(?: \(([^)]*)\))?\s*(.*)$/;
const LOG_HEADER_LINE = /^(?:Author|Date|Merge):/;
const LOG_MESSAGE_LINE = /^\s{4}(.*)$/;

function parseGitLog(text: string): GitLogParsed | null {
	const lines = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return { kind: "log", commits: [] };

	// Oneline format (`git log --oneline`): every line is `hash [refs] subject`.
	if (lines.every((line) => LOG_ONELINE.test(line))) {
		const commits = lines.map((line) => {
			const match = LOG_ONELINE.exec(line);
			const refs = match?.[2];
			return {
				hash: match?.[1] ?? "",
				...(refs ? { refs } : {}),
				subject: (match?.[3] ?? "").trim(),
			};
		});
		return { kind: "log", commits };
	}

	// Full format: `commit <hash> [refs]` blocks with Author/Date/Merge headers
	// and a 4-space-indented message.
	const commits: GitLogCommit[] = [];
	let current: { hash: string; refs?: string; subject: string } | null = null;
	for (const line of lines) {
		const start = LOG_COMMIT_LINE.exec(line);
		if (start) {
			current = {
				hash: start[1] ?? "",
				...(start[2] ? { refs: start[2] } : {}),
				subject: "",
			};
			commits.push(current);
			continue;
		}
		if (!current) return null;
		if (LOG_HEADER_LINE.test(line)) continue;
		const message = LOG_MESSAGE_LINE.exec(line);
		if (message) {
			if (current.subject === "") current.subject = (message[1] ?? "").trim();
			continue;
		}
		return null; // unexpected line inside a commit block (patch/format output)
	}
	if (commits.length === 0) return null;
	return { kind: "log", commits };
}

// ── git show --stat parser ───────────────────────────────────────────────────
// `git show --stat` = a full-format commit header (the same shape `parseGitLog`
// reads: `commit <hash>`, Author/Date/Merge, 4-space-indented message) followed
// by the same stat block `parseGitDiffStat` reads. The header is consumed first
// (subject = first message line), then the remainder is handed to the diff-stat
// line parser; any hostile line fails closed → raw boxed shell (ADR 0005).

function parseGitShowStat(text: string): GitShowStatParsed | null {
	const lines = String(text ?? "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd());
	let i = 0;
	while (i < lines.length && (lines[i] ?? "") === "") i++; // skip leading blanks
	if (i >= lines.length) return null;
	const commitMatch = LOG_COMMIT_LINE.exec(lines[i] ?? "");
	if (!commitMatch) return null; // not a `git show` commit header
	const hash = commitMatch[1] ?? "";
	i++;
	let subject = "";
	// Consume the commit header: Author/Date/Merge lines, blank lines, and the
	// 4-space-indented message block (subject = first message line). The first
	// line that is none of these begins the stat block. Stat rows carry only a
	// single leading space, so they never match the 4-space message pattern.
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line === "") {
			i++;
			continue;
		}
		if (LOG_HEADER_LINE.test(line)) {
			i++;
			continue;
		}
		const message = LOG_MESSAGE_LINE.exec(line);
		if (message) {
			if (subject === "") subject = (message[1] ?? "").trim();
			i++;
			continue;
		}
		break;
	}
	// The remainder is the diff-stat block (empty for a commit with no file
	// changes). Reuse the diff-stat line parser, fail-closed on hostile lines.
	const stat = parseGitDiffStat(lines.slice(i).join("\n"));
	if (!stat) return null;
	return {
		kind: "show-stat",
		hash,
		subject,
		files: stat.files,
		...(stat.filesChanged !== undefined ? { filesChanged: stat.filesChanged } : {}),
		...(stat.insertions !== undefined ? { insertions: stat.insertions } : {}),
		...(stat.deletions !== undefined ? { deletions: stat.deletions } : {}),
	};
}

// ── git diff / git show parser ──────────────────────────────────────────────
// Splits unified diff output into per-file chunks, strips file headers and
// hunk headers, and converts content lines into the numbered `<prefix> <num>
// <content>` shape `buildSplitRows` (the `AdaptiveDiffComponent` input) reads.
// Every ambiguity returns null → the boxed Bash shell renders raw (ADR 0005).

const DIFF_GIT_HEADER = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const NEW_FILE_MODE = /^new file mode /;
const DELETED_FILE_MODE = /^deleted file mode /;

/** Strip the `a/` / `b/` prefix (and surrounding quotes) from a `--- `/`+++ ` path. */
function stripDiffPathPrefix(rawPath: string): string {
	let path = rawPath;
	if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
	if (path.startsWith("a/")) return path.slice(2);
	if (path.startsWith("b/")) return path.slice(2);
	return path;
}

function parseDiffChunk(chunk: readonly string[]): GitDiffFile | null {
	const header = chunk[0] ?? "";
	const dgMatch = DIFF_GIT_HEADER.exec(header);
	if (!dgMatch) return null;
	const dgOld = dgMatch[1] ?? undefined;
	const dgNew = dgMatch[2] ?? undefined;

	let oldPath: string | undefined;
	let newPath: string | undefined;
	let status: GitDiffFile["status"];
	let binary = false;
	let renameDetected = false;
	const bodyLines: string[] = [];
	let additions = 0;
	let removals = 0;
	let inHunk = false;
	let oldLine = 0;
	let newLine = 0;

	for (let i = 1; i < chunk.length; i++) {
		const line = chunk[i] ?? "";

		const hunk = HUNK_HEADER.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1] ?? 0);
			newLine = Number(hunk[2] ?? 0);
			inHunk = true;
			continue;
		}

		if (!inHunk) {
			if (line === "") continue; // section separator
			if (line.startsWith("index ")) continue;
			if (NEW_FILE_MODE.test(line)) {
				status = "added";
				continue;
			}
			if (DELETED_FILE_MODE.test(line)) {
				status = "deleted";
				continue;
			}
			if (line.startsWith("old mode ") || line.startsWith("new mode ")) continue;
			if (line.startsWith("similarity index ") || line.startsWith("dissimilarity index ")) {
				renameDetected = true;
				continue;
			}
			if (line.startsWith("rename from ")) {
				oldPath = line.slice("rename from ".length);
				renameDetected = true;
				status = "renamed";
				continue;
			}
			if (line.startsWith("rename to ")) {
				newPath = line.slice("rename to ".length);
				renameDetected = true;
				status = "renamed";
				continue;
			}
			if (line.startsWith("copy from ") || line.startsWith("copy to ")) continue;
			if (line.startsWith("--- ")) {
				const value = line.slice(4);
				if (value !== "/dev/null") oldPath = stripDiffPathPrefix(value);
				continue;
			}
			if (line.startsWith("+++ ")) {
				const value = line.slice(4);
				if (value !== "/dev/null") newPath = stripDiffPathPrefix(value);
				continue;
			}
			if (line.startsWith("Binary files ") || line === "Binary files differ") {
				binary = true;
				const bm = line.match(/^Binary files (?:a\/(\S*) )?and (?:b\/(\S*) )?differ/);
				if (bm) {
					if (!oldPath && bm[1]) oldPath = bm[1];
					if (!newPath && bm[2]) newPath = bm[2];
				}
				continue;
			}
			if (line.startsWith("GIT binary patch")) return null; // unparseable binary patch body
			return null; // unrecognized header line → hostile/localized output
		}

		// inside a hunk
		if (line.startsWith("\\ No newline")) continue;
		if (line.startsWith("+")) {
			bodyLines.push(`+ ${newLine} ${line.slice(1)}`);
			newLine++;
			additions++;
			continue;
		}
		if (line.startsWith("-")) {
			bodyLines.push(`- ${oldLine} ${line.slice(1)}`);
			oldLine++;
			removals++;
			continue;
		}
		if (line.startsWith(" ")) {
			bodyLines.push(` ${oldLine} ${line.slice(1)}`);
			oldLine++;
			newLine++;
			continue;
		}
		if (line === "") {
			// Blank context line whose leading space was stripped (trailing-ws
			// safety): keep it as an empty context row so the diff stays aligned.
			bodyLines.push(` ${oldLine} `);
			oldLine++;
			newLine++;
			continue;
		}
		return null; // unexpected line inside a hunk
	}

	if (!newPath) newPath = dgNew;
	if (!oldPath) oldPath = dgOld;
	let displayPath: string;
	if (renameDetected && oldPath && newPath && oldPath !== newPath) {
		displayPath = `${oldPath} => ${newPath}`;
	} else {
		displayPath = newPath ?? oldPath ?? "(unknown)";
	}
	if (!status) {
		if (binary) status = "modified";
		else if (oldPath && newPath) status = "modified";
		else if (newPath && !oldPath) status = "added";
		else if (oldPath && !newPath) status = "deleted";
	}

	return {
		path: displayPath,
		...(status ? { status } : {}),
		...(binary ? { binary: true } : {}),
		additions,
		removals,
		body: bodyLines.join("\n"),
	};
}

function parseUnifiedDiff(text: string): GitDiffFile[] | null {
	if (text === "") return []; // empty diff (no changes)
	const lines = text.split("\n");
	// Drop a single trailing empty line produced by the final newline.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const chunks: string[][] = [];
	let current: string[] | null = null;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			if (current) chunks.push(current);
			current = [line];
		} else if (current) {
			current.push(line);
		} else {
			return null; // content before the first `diff --git` (unrecognized prefix)
		}
	}
	if (current) chunks.push(current);
	if (chunks.length === 0) return null;
	const files: GitDiffFile[] = [];
	for (const chunk of chunks) {
		const file = parseDiffChunk(chunk);
		if (!file) return null;
		files.push(file);
	}
	return files;
}

const SHOW_COMMIT_LINE = /^commit ([0-9a-f]{4,40})/;
const SHOW_SUBJECT_LINE = /^ {4}(.+)$/;

function parseGitDiff(text: string, show: boolean): GitDiffParsed | null {
	const raw = String(text ?? "").replace(/\r/g, "");
	let body = raw;
	let hash: string | undefined;
	let subject: string | undefined;
	if (show) {
		const diffIndex = raw.indexOf("diff --git");
		if (diffIndex < 0) return null; // commit with no patch / blob content → raw shell
		const headerPart = raw.slice(0, diffIndex);
		body = raw.slice(diffIndex);
		const commitMatch = SHOW_COMMIT_LINE.exec(headerPart);
		if (commitMatch) hash = commitMatch[1];
		for (const headerLine of headerPart.split("\n")) {
			const subjectMatch = SHOW_SUBJECT_LINE.exec(headerLine);
			if (subjectMatch) {
				subject = (subjectMatch[1] ?? "").trim();
				break;
			}
		}
	}
	const files = parseUnifiedDiff(body);
	if (!files) return null;
	return {
		kind: "diff",
		show,
		files,
		...(hash !== undefined ? { hash } : {}),
		...(subject !== undefined ? { subject } : {}),
	};
}

// ── git commit / push / pull / fetch parsers ─────────────────────────────────
// State-change commands render a boxless summary card when their output parses
// (ADR 0005). Every parser is fail-closed: a single unrecognized line returns
// null and the boxed Bash shell renders raw. `git commit` with nothing staged
// exits nonzero; those informational exit-1 shapes (clean tree, unstaged-only)
// still parse to a `nothing to commit` card, while genuine errors (push
// rejected, hook failure) hold an unrecognized line and fall back raw.

/** `[<branch> <hash>] <subject>` — the first line of a successful commit. */
const COMMIT_SUCCESS = /^\[(\S+) ([0-9a-f]{7,40})\] (.*)$/;

/** Ref-update line with a status marker + bracketed/bare label, after leading
 *  whitespace is trimmed: `* [new branch] src -> dst`, `* branch src -> dst`,
 *  `= [up to date] src -> dst`. `!` (rejected) is excluded so rejected pushes
 *  fall back to the raw shell instead of rendering a partial card. */
const REF_CHAR_LABEL = /^([*=.-]) (?:\[([^\]]*)\]|(\S+))\s+(\S+)\s+->\s+(\S+)$/;
/** Ref-update line carrying a hash range (update), after trimming:
 *  `<a>..<b> src -> dst`. */
const REF_RANGE = /^([0-9a-f]{4,}\.\.[0-9a-f]{4,})\s+(\S+)\s+->\s+(\S+)$/;

/** Normalize a push/fetch ref-update line by collapsing alignment whitespace
 *  to single spaces. Returns null when the line is neither a char-labeled nor a
 *  range ref update (caller fails closed). */
function normalizeRefLine(trimmed: string): string | null {
	const labeled = REF_CHAR_LABEL.exec(trimmed);
	if (labeled) {
		const marker = labeled[1] ?? "";
		const label = labeled[2] !== undefined ? `[${labeled[2]}]` : (labeled[3] ?? "");
		return `${marker} ${label} ${labeled[4]} -> ${labeled[5]}`;
	}
	const range = REF_RANGE.exec(trimmed);
	if (range) return `${range[1]} ${range[2]} -> ${range[3]}`;
	return null;
}

/** Push/fetch progress chatter lines (stderr mixed into the captured output)
 *  that carry no ref information — skipped without failing the parse. */
function isProgressNoise(line: string): boolean {
	return (
		/^(?:Enumerating|Counting|Compressing|Writing|Deltaing|Resolving|Using) objects:/i.test(line) ||
		/^Total \d+/i.test(line) ||
		line.startsWith("remote: ") ||
		line.startsWith("remote:")
	);
}

function parseGitCommit(text: string): GitActionParsed | null {
	const lines = String(text ?? "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd());
	let start = 0;
	while (start < lines.length && (lines[start] ?? "") === "") start++;
	let end = lines.length;
	while (end > start && (lines[end - 1] ?? "") === "") end--;
	const body = lines.slice(start, end);
	if (body.length === 0) return null;

	const head = COMMIT_SUCCESS.exec(body[0] ?? "");
	if (head) {
		const branch = head[1] ?? "";
		const hash = head[2] ?? "";
		const subject = (head[3] ?? "").trim();
		if (!branch || !hash) return null;
		// Without `-v` only an optional summary line follows; any other extra line
		// (a per-file row, editor output) fails closed.
		let filesChanged: number | undefined;
		let insertions: number | undefined;
		let deletions: number | undefined;
		for (const line of body.slice(1)) {
			const summary = DIFF_STAT_SUMMARY.exec(line);
			if (!summary) return null;
			filesChanged = Number(summary[1]);
			if (summary[2] !== undefined) insertions = Number(summary[2]);
			if (summary[3] !== undefined) deletions = Number(summary[3]);
		}
		return {
			kind: "action",
			command: "commit",
			files: [],
			branch,
			hash,
			...(subject ? { subject } : {}),
			...(filesChanged !== undefined ? { filesChanged } : {}),
			...(insertions !== undefined ? { insertions } : {}),
			...(deletions !== undefined ? { deletions } : {}),
		};
	}

	// `git commit` with nothing to commit exits 1: either a clean tree or
	// unstaged/untracked-only changes. Both carry `On branch <name>` and a
	// terminator line; render a single `nothing to commit` row.
	const first = body[0] ?? "";
	const last = body[body.length - 1] ?? "";
	const cleanNothing = body.some((line) => line === "nothing to commit, working tree clean");
	const unstagedNothing = last.startsWith("no changes added to commit");
	if (/^On branch .+/.test(first) && (cleanNothing || unstagedNothing)) {
		return { kind: "action", command: "commit", files: [], status: "nothing to commit" };
	}
	return null;
}

function parseGitPush(text: string): GitActionParsed | null {
	let remote: string | undefined;
	let status: string | undefined;
	const refs: string[] = [];
	let sawContent = false;
	for (const rawLine of String(text ?? "")
		.replace(/\r/g, "")
		.split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") continue;
		if (isProgressNoise(line)) continue;
		if (/^branch '.*' set up to track '.*'\.$/.test(line)) continue; // tracking info
		if (line.startsWith("Pushing to ")) continue; // verbose (rejected) preamble
		const toLine = /^To (.+)$/.exec(line);
		if (toLine) {
			sawContent = true;
			remote = toLine[1] ?? "";
			continue;
		}
		if (line === "Everything up-to-date") {
			sawContent = true;
			status = "Everything up-to-date";
			continue;
		}
		const ref = normalizeRefLine(line.trim());
		if (ref) {
			sawContent = true;
			refs.push(ref);
			continue;
		}
		return null; // rejected (`! [...]`), error:, or unknown line → fail closed
	}
	if (!sawContent) return null;
	return {
		kind: "action",
		command: "push",
		files: [],
		...(remote !== undefined ? { remote } : {}),
		...(status !== undefined ? { status } : {}),
		...(refs.length > 0 ? { refs } : {}),
	};
}

function parseGitPull(text: string): GitActionParsed | null {
	const lines = String(text ?? "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd());
	const nonEmpty = lines.filter((line) => line !== "");
	if (nonEmpty.length === 0) return null;
	if (nonEmpty.length === 1 && nonEmpty[0] === "Already up to date.") {
		return { kind: "action", command: "pull", files: [], status: "Already up to date." };
	}

	// Fast-forward: an optional `From <url>`/ref block, then `Updating a..b`,
	// `Fast-forward`, and the same per-file stat block `git diff --stat` reads.
	let range: string | undefined;
	let ffIndex = -1;
	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx] ?? "";
		if (line === "") continue;
		if (line.startsWith("From ")) continue;
		if (/^\s+[0-9a-f]{4,}\.\.[0-9a-f]{4,}\s+.+ -> .+$/.test(line)) continue; // fetch-style ref row
		const updating = /^Updating ([0-9a-f]{4,}\.\.[0-9a-f]{4,})$/.exec(line);
		if (updating) {
			range = updating[1] ?? "";
			continue;
		}
		if (line === "Fast-forward") {
			ffIndex = idx;
			break;
		}
		return null; // merge output, conflict markers, localized text → fail closed
	}
	if (!range || ffIndex < 0) return null;
	const stat = parseGitDiffStat(lines.slice(ffIndex + 1).join("\n"));
	if (!stat) return null;
	return {
		kind: "action",
		command: "pull",
		files: stat.files,
		status: "Fast-forward",
		range,
		...(stat.filesChanged !== undefined ? { filesChanged: stat.filesChanged } : {}),
		...(stat.insertions !== undefined ? { insertions: stat.insertions } : {}),
		...(stat.deletions !== undefined ? { deletions: stat.deletions } : {}),
	};
}

function parseGitFetch(text: string): GitActionParsed | null {
	let remote: string | undefined;
	const refs: string[] = [];
	let sawContent = false;
	for (const rawLine of String(text ?? "")
		.replace(/\r/g, "")
		.split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") continue;
		if (isProgressNoise(line)) continue;
		const fromLine = /^From (.+)$/.exec(line);
		if (fromLine) {
			sawContent = true;
			remote = fromLine[1] ?? "";
			continue;
		}
		const ref = normalizeRefLine(line.trim());
		if (ref) {
			sawContent = true;
			refs.push(ref);
			continue;
		}
		return null; // unknown line → fail closed
	}
	if (!sawContent) return { kind: "action", command: "fetch", files: [], status: "no new refs" };
	return {
		kind: "action",
		command: "fetch",
		files: [],
		...(remote !== undefined ? { remote } : {}),
		...(refs.length > 0 ? { refs } : {}),
	};
}

/** Lines appended to a merge/pull fast-forward stat block (after the summary)
 *  that carry no per-file change count — file mode/creation/deletion/rename
 *  notices. Filtered before the diff-stat line parser runs so merge stat
 *  blocks parse; legit stat rows (`path | N`, `path | Bin`, the summary) never
 *  match these shapes, so filtering is safe (ADR 0005). */
const DIFF_STAT_NOTICE_LINE =
	/^\s+(?:create|delete) mode \d+ |^\s+(?:old|new) mode |^\s+mode change |^\s+(?:similarity|dissimilarity) index |^\s+(?:rename|copy) (?:from|to) |^\s+rewrite /;

/** Parse a diff-stat block that may carry trailing file-mode/rename notices
 *  (merge / pull fast-forward output). Shares `parseGitDiffStat` after the
 *  notices are stripped; fails closed on any other hostile line. */
function parseGitDiffStatTolerant(text: string): GitDiffStatParsed | null {
	const filtered = String(text ?? "")
		.split("\n")
		.filter((line) => !DIFF_STAT_NOTICE_LINE.test(line))
		.join("\n");
	return parseGitDiffStat(filtered);
}

/** `git switch`/`checkout`: `Switched to a new branch 'X'`, `Switched to branch
 *  'X'`, `Already on 'X'`, silent success (empty), or `Updated N paths from
 *  the index` (checkout of paths). Advisory `Your branch …` lines are skipped
 *  (the status line owns branch state). */
const SWITCH_NEW_BRANCH = /^Switched to a new branch '(.+)'$/;
const SWITCH_BRANCH = /^Switched to branch '(.+)'$/;
const SWITCH_ALREADY = /^Already on '(.+)'$/;
const CHECKOUT_PATHS = /^Updated (\d+) paths? from the index$/;

function parseGitSwitchCheckout(text: string, command: "switch" | "checkout"): GitActionParsed | null {
	const significant: string[] = [];
	for (const rawLine of String(text ?? "")
		.replace(/\r/g, "")
		.split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") continue;
		// Advisory branch-state lines and their hints — the status line owns `⎇ main`.
		if (line.startsWith("Your branch ")) continue;
		if (/^\s+\(/.test(line)) continue;
		significant.push(line);
	}
	if (significant.length === 0) {
		return { kind: "action", command, files: [], status: "completed, no output" };
	}
	if (significant.length === 1) {
		const line = significant[0] ?? "";
		const created = SWITCH_NEW_BRANCH.exec(line);
		if (created && created[1] !== undefined)
			return { kind: "action", command, files: [], branch: created[1], created: true };
		const existing = SWITCH_BRANCH.exec(line);
		if (existing && existing[1] !== undefined) return { kind: "action", command, files: [], branch: existing[1] };
		const already = SWITCH_ALREADY.exec(line);
		if (already && already[1] !== undefined) return { kind: "action", command, files: [], branch: already[1] };
		const paths = CHECKOUT_PATHS.exec(line);
		if (paths) {
			const count = Number(paths[1]);
			return {
				kind: "action",
				command,
				files: [],
				status: `Updated ${count} ${pluralForm("file", count)} from the index`,
			};
		}
	}
	return null; // detached-HEAD note, `switch -m` merge rows, localized text → fail closed
}

/** `git add`/`restore`: success is silent (empty output). Any non-empty output
 *  is an error/`-v` listing/localized text → fail closed. */
function parseGitAddRestore(text: string, command: "add" | "restore"): GitActionParsed | null {
	const body = String(text ?? "").replace(/\r/g, "");
	if (body.trim() === "") {
		return { kind: "action", command, files: [], status: "completed, no output" };
	}
	return null;
}

/** `git reset`: `HEAD is now at <hash> <subject>` (`--hard`/`--keep`), the
 *  `Unstaged changes after reset:` block with `<marker>\t<path>` rows
 *  (`--mixed`), or silent success (`--soft`, or a clean mixed reset). */
const RESET_HEAD_NOW = /^HEAD is now at ([0-9a-f]{4,40}) (.*)$/;
const RESET_UNSTAGED_HEADER = "Unstaged changes after reset:";
const RESET_UNSTAGED_ROW = /^([MADRC?!]{1,2})\t(.+)$/;

function parseGitReset(text: string): GitActionParsed | null {
	const lines = String(text ?? "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd());
	const nonEmpty = lines.filter((line) => line !== "");
	if (nonEmpty.length === 0) {
		return { kind: "action", command: "reset", files: [], status: "completed, no output" };
	}
	if (nonEmpty.length === 1) {
		const head = RESET_HEAD_NOW.exec(nonEmpty[0] ?? "");
		if (head && head[1] !== undefined) {
			const subject = (head[2] ?? "").trim();
			return {
				kind: "action",
				command: "reset",
				files: [],
				hash: head[1],
				...(subject ? { subject } : {}),
			};
		}
		return null;
	}
	if ((nonEmpty[0] ?? "") === RESET_UNSTAGED_HEADER) {
		const resetFiles: GitStatusFile[] = [];
		for (const row of nonEmpty.slice(1)) {
			const match = RESET_UNSTAGED_ROW.exec(row ?? "");
			if (!match) return null;
			const marker = match[1] ?? "";
			resetFiles.push({ x: marker[0] ?? " ", y: marker[1] ?? " ", path: match[2] ?? "" });
		}
		if (resetFiles.length === 0) return null;
		return { kind: "action", command: "reset", files: [], resetFiles };
	}
	return null; // unrecognized multi-line shape → fail closed
}

/** `git merge`: `Already up to date.`, a fast-forward (`Updating a..b` +
 *  `Fast-forward` + stat block), or `Merge made by the '…' strategy.` + stat
 *  block. Conflicts exit nonzero and hold unrecognized lines → fail closed. */
const MERGE_UPDATING = /^Updating ([0-9a-f]{4,}\.\.[0-9a-f]{4,})$/;
const MERGE_MADE = /^Merge made by the '.*' strategy\.$/;

function parseGitMerge(text: string): GitActionParsed | null {
	const lines = String(text ?? "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd());
	let start = 0;
	while (start < lines.length && (lines[start] ?? "") === "") start++;
	let end = lines.length;
	while (end > start && (lines[end - 1] ?? "") === "") end--;
	const body = lines.slice(start, end);
	if (body.length === 0) return null; // merge always reports; empty → hostile

	if (body.length === 1 && (body[0] ?? "") === "Already up to date.") {
		return { kind: "action", command: "merge", files: [], status: "Already up to date." };
	}

	let idx = 0;
	let range: string | undefined;
	const updating = MERGE_UPDATING.exec(body[0] ?? "");
	if (updating) {
		range = updating[1];
		idx = 1;
	}
	const marker = body[idx] ?? "";
	if (range && marker === "Fast-forward") {
		const stat = parseGitDiffStatTolerant(body.slice(idx + 1).join("\n"));
		if (!stat) return null;
		return {
			kind: "action",
			command: "merge",
			files: stat.files,
			status: "Fast-forward",
			range,
			...(stat.filesChanged !== undefined ? { filesChanged: stat.filesChanged } : {}),
			...(stat.insertions !== undefined ? { insertions: stat.insertions } : {}),
			...(stat.deletions !== undefined ? { deletions: stat.deletions } : {}),
		};
	}
	if (MERGE_MADE.exec(marker)) {
		const stat = parseGitDiffStatTolerant(body.slice(idx + 1).join("\n"));
		if (!stat) return null;
		return {
			kind: "action",
			command: "merge",
			files: stat.files,
			status: marker,
			...(stat.filesChanged !== undefined ? { filesChanged: stat.filesChanged } : {}),
			...(stat.insertions !== undefined ? { insertions: stat.insertions } : {}),
			...(stat.deletions !== undefined ? { deletions: stat.deletions } : {}),
		};
	}
	return null; // conflict markers, `--squash`/`--abort` output → fail closed
}

/** `git rebase`: `Successfully rebased and updated refs/heads/<branch>.` or
 *  `Current branch <branch> is up to date.`. The `Rebasing (N/M)` progress is
 *  carriage-return-separated; `\r` is split into its own line and dropped.
 *  Conflicts/`--abort`/`--continue` exit nonzero and fail closed. */
const REBASE_SUCCESS = /^Successfully rebased and updated refs\/heads\/(.+)$/;
const REBASE_UPTODATE = /^Current branch (.+) is up to date\.$/;

function parseGitRebase(text: string): GitActionParsed | null {
	const significant: string[] = [];
	for (const rawLine of String(text ?? "")
		.replace(/\r/g, "\n")
		.split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") continue;
		// Progress chatter written with a carriage return, then overwritten.
		if (/^Rebasing \(\d+\/\d+\)/.test(line)) continue;
		if (/^Rewriting commits \(\d+\/\d+\)/.test(line)) continue;
		significant.push(line);
	}
	if (significant.length === 1) {
		const line = significant[0] ?? "";
		const success = REBASE_SUCCESS.exec(line);
		if (success && success[1] !== undefined)
			return {
				kind: "action",
				command: "rebase",
				files: [],
				branch: success[1].replace(/\.$/, ""),
				status: "Rebased",
			};
		const upToDate = REBASE_UPTODATE.exec(line);
		if (upToDate && upToDate[1] !== undefined)
			return { kind: "action", command: "rebase", files: [], branch: upToDate[1], status: "Up to date." };
	}
	return null; // conflict, `--abort`/`--continue`, interactive editor → fail closed
}

function parseGitAction(command: GitActionParsed["command"], text: string): GitActionParsed | null {
	if (command === "commit") return parseGitCommit(text);
	if (command === "push") return parseGitPush(text);
	if (command === "pull") return parseGitPull(text);
	if (command === "fetch") return parseGitFetch(text);
	if (command === "switch" || command === "checkout") return parseGitSwitchCheckout(text, command);
	if (command === "add" || command === "restore") return parseGitAddRestore(text, command);
	if (command === "reset") return parseGitReset(text);
	if (command === "merge") return parseGitMerge(text);
	return parseGitRebase(text);
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** Nerd Font git-branch glyph used on git card headers in Nerd Font mode. */
export const GIT_ICON = "\u{E725}";

const GIT_CARD_HEAD_LIMIT = 6;
const GIT_CONFLICT_PAIRS = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);

function gitCardHeader(theme: BoxTheme, cls: GitSemanticClass, parsed?: GitParsedSemantic): string {
	const icon = getToolsRenderConfig().nerdFonts ? `${GIT_ICON} ` : "";
	let prefix: string;
	if (cls.kind === "diff") {
		const label = cls.show ? "Git show" : "Git diff";
		prefix = `${icon}${label}`;
		if (cls.show && parsed?.kind === "diff" && parsed.hash) {
			const shortHash = parsed.hash.slice(0, 7);
			prefix += ` · ${shortHash}`;
			if (parsed.subject) prefix += ` · ${parsed.subject}`;
		}
	} else if (cls.kind === "show-stat") {
		prefix = `${icon}Git show`;
		if (parsed?.kind === "show-stat") {
			prefix += ` · ${parsed.hash.slice(0, 7)}`;
			if (parsed.subject) prefix += ` · ${parsed.subject}`;
		}
	} else if (cls.kind === "action") {
		const label =
			cls.command === "commit"
				? "Git commit"
				: cls.command === "push"
					? "Git push"
					: cls.command === "pull"
						? "Git pull"
						: cls.command === "fetch"
							? "Git fetch"
							: cls.command === "switch"
								? "Git switch"
								: cls.command === "checkout"
									? "Git checkout"
									: cls.command === "add"
										? "Git add"
										: cls.command === "restore"
											? "Git restore"
											: cls.command === "reset"
												? "Git reset"
												: cls.command === "merge"
													? "Git merge"
													: "Git rebase";
		prefix = `${icon}${label}`;
		// Header detail carries the parsed identity, matching `Git show · hash ·
		// subject`: a commit's `[<branch> <hash>] <subject>`, a switch/checkout
		// target branch, a reset --hard `HEAD is now at <hash> <subject>`, or a
		// rebase `<branch>`. add/restore/merge stay label-only.
		if (parsed?.kind === "action") {
			if ((parsed.command === "commit" || parsed.command === "reset") && parsed.hash) {
				prefix += ` · ${parsed.hash.slice(0, 7)}`;
				if (parsed.subject) prefix += ` · ${parsed.subject}`;
			} else if (
				(parsed.command === "switch" || parsed.command === "checkout" || parsed.command === "rebase") &&
				parsed.branch
			) {
				prefix += ` · ${parsed.branch}`;
			}
		}
	} else {
		const label = cls.kind === "status" ? "Git status" : cls.kind === "diff-stat" ? "Git diff --stat" : "Git log";
		prefix = `${icon}${label}`;
	}
	return typeof theme?.bold === "function" ? theme.bold(prefix) : prefix;
}

function statusMarker(file: GitStatusFile): string {
	const xy = `${file.x}${file.y}`;
	if (GIT_CONFLICT_PAIRS.has(xy)) return "U";
	if (file.x === "?" || file.x === "!") return file.x;
	const staged = file.x !== " " ? file.x : "";
	const worktree = file.y !== " " && file.y !== "?" && file.y !== "!" ? file.y : "";
	return `${staged}${worktree}` || " ";
}

function statusMarkColor(file: GitStatusFile): string {
	const xy = `${file.x}${file.y}`;
	if (GIT_CONFLICT_PAIRS.has(xy)) return "error";
	if (file.x === "?") return "warning";
	if (file.x === "!") return "dim";
	if (file.x !== " ") return "accent";
	return "toolOutput";
}

function statusCounts(theme: BoxTheme, parsed: GitStatusParsed): string[] {
	let staged = 0;
	let modified = 0;
	let untracked = 0;
	let ignored = 0;
	let conflicted = 0;
	for (const file of parsed.files) {
		const xy = `${file.x}${file.y}`;
		if (GIT_CONFLICT_PAIRS.has(xy)) conflicted++;
		else if (file.x === "?" || file.x === "!") {
			if (file.x === "!") ignored++;
			else untracked++;
		} else if (file.x !== " ") staged++;
		else if (file.y !== " ") modified++;
	}

	const parts: string[] = [];
	if (conflicted > 0) parts.push(theme.fg("error", `${conflicted} conflicted`));
	if (staged > 0) parts.push(theme.fg("accent", `${staged} staged`));
	if (modified > 0) parts.push(theme.fg("accent", `${modified} modified`));
	if (untracked > 0) parts.push(theme.fg("warning", `${untracked} untracked`));
	if (ignored > 0) parts.push(theme.fg("dim", `${ignored} ignored`));
	return parts;
}

function renderStatusCard(theme: BoxTheme, parsed: GitStatusParsed, out: string[], width: number): string[] {
	const counts = statusCounts(theme, parsed);
	if (counts.length > 0) out.push(`  ${counts.join(theme.fg("dim", " · "))}`);
	else out.push(theme.fg("muted", "  nothing to commit, working tree clean"));

	// Branch is only shown when it affects the result (push/merge/ahead-behind);
	// the status line owns `⎇ main` (ADR 0005).
	if (parsed.branch && (parsed.ahead !== undefined || parsed.behind !== undefined)) {
		const parts = [theme.fg("text", parsed.branch)];
		if (parsed.ahead !== undefined) parts.push(theme.fg("accent", `ahead ${parsed.ahead}`));
		if (parsed.behind !== undefined) parts.push(theme.fg("warning", `behind ${parsed.behind}`));
		out.push(`  ${parts.join(theme.fg("dim", " · "))}`);
	}

	const files = parsed.files;
	return renderStatusFileRows(theme, files, out, width);
}

/** Shared `├─ M  path` rows for status-style file lists (status card + reset). */
function renderStatusFileRows(
	theme: BoxTheme,
	files: readonly GitStatusFile[],
	out: string[],
	width: number,
): string[] {
	const visible = files.slice(0, GIT_CARD_HEAD_LIMIT);
	const more = files.length - visible.length;
	const lastIndex = visible.length - 1;
	for (let i = 0; i < visible.length; i++) {
		const file = visible[i];
		if (!file) continue;
		const branch = i < lastIndex || more > 0 ? "├─" : "└─";
		const mark = statusMarker(file);
		const line = `${TREE_INDENT}${dimLine(branch)} ${theme.fg(statusMarkColor(file), mark)}  ${theme.fg("toolOutput", file.path)}`;
		out.push(safeTruncateToWidth(line, width, "…"));
	}
	if (more > 0) {
		out.push(
			safeTruncateToWidth(
				`${TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm("file", more)}`)}`,
				width,
				"…",
			),
		);
	}
	return out;
}

function renderDiffStatCard(theme: BoxTheme, parsed: DiffStatSummary, out: string[], width: number): string[] {
	const summaryParts: string[] = [];
	if (parsed.filesChanged !== undefined) {
		summaryParts.push(theme.fg("accent", `${parsed.filesChanged} ${pluralForm("file", parsed.filesChanged)} changed`));
	}
	// +/− totals sit adjacent (no separator between them), unlike the `·`-joined parts.
	const diffParts: string[] = [];
	if (parsed.insertions !== undefined && parsed.insertions > 0) {
		diffParts.push(theme.fg("toolDiffAdded", `+${parsed.insertions}`));
	}
	if (parsed.deletions !== undefined && parsed.deletions > 0) {
		diffParts.push(theme.fg("toolDiffRemoved", `-${parsed.deletions}`));
	}
	if (diffParts.length > 0) summaryParts.push(diffParts.join(" "));
	if (summaryParts.length > 0) out.push(`  ${summaryParts.join(theme.fg("dim", " · "))}`);
	else out.push(theme.fg("muted", "  no changes"));

	const files = parsed.files;
	const visible = files.slice(0, GIT_CARD_HEAD_LIMIT);
	const more = files.length - visible.length;
	const lastIndex = visible.length - 1;
	for (let i = 0; i < visible.length; i++) {
		const file = visible[i];
		if (!file) continue;
		const branch = i < lastIndex || more > 0 ? "├─" : "└─";
		const changes = file.changes ?? 0;
		const detail = theme.fg("dim", file.binary ? "· binary" : `· ${changes} ${pluralForm("change", changes)}`);
		const line = `${TREE_INDENT}${dimLine(branch)} ${theme.fg("toolOutput", file.path)} ${detail}`;
		out.push(safeTruncateToWidth(line, width, "…"));
	}
	if (more > 0) {
		out.push(
			safeTruncateToWidth(
				`${TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm("file", more)}`)}`,
				width,
				"…",
			),
		);
	}
	return out;
}

function renderLogCard(theme: BoxTheme, parsed: GitLogParsed, out: string[], width: number): string[] {
	const commits = parsed.commits;
	if (commits.length === 0) {
		out.push(theme.fg("muted", "  no commits"));
		return out;
	}

	const visible = commits.slice(0, GIT_CARD_HEAD_LIMIT);
	const more = commits.length - visible.length;
	const lastIndex = visible.length - 1;
	for (let i = 0; i < visible.length; i++) {
		const commit = visible[i];
		if (!commit) continue;
		const branch = i < lastIndex || more > 0 ? "├─" : "└─";
		const refs = commit.refs ? ` (${commit.refs})` : "";
		const subject = commit.subject ? `  ${commit.subject}` : "";
		const line = `${TREE_INDENT}${dimLine(branch)} ${theme.fg("accent", commit.hash)}${theme.fg("dim", refs)}${theme.fg("toolOutput", subject)}`;
		out.push(line);
	}
	if (more > 0) {
		out.push(
			safeTruncateToWidth(
				`${TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm("commit", more)}`)}`,
				width,
				"…",
			),
		);
	}
	return out;
}

function renderDiffCard(theme: BoxTheme, parsed: GitDiffParsed, out: string[], width: number): string[] {
	const files = parsed.files;
	if (files.length === 0) {
		out.push(theme.fg("muted", "  no changes"));
		return out;
	}
	let additions = 0;
	let removals = 0;
	for (const file of files) {
		additions += file.additions;
		removals += file.removals;
	}
	const parts: string[] = [theme.fg("accent", `${files.length} ${pluralForm("file", files.length)}`)];
	if (additions > 0) parts.push(theme.fg("toolDiffAdded", `+${additions}`));
	if (removals > 0) parts.push(theme.fg("toolDiffRemoved", `-${removals}`));
	out.push(safeTruncateToWidth(`  ${parts.join(" ")}`, width, "…"));
	return out;
}

/** Render a state-change card. `commit`/`pull` reuse the diff-stat summary +
 *  `├─/└─` rows; `push`/`fetch` show the remote (dim) and normalized ref rows.
 *  Every line is width-safe (the caller truncates again). */
function renderActionCard(theme: BoxTheme, parsed: GitActionParsed, out: string[], width: number): string[] {
	if (parsed.command === "commit") {
		if (parsed.status) {
			out.push(theme.fg("muted", `  ${parsed.status}`)); // nothing to commit
			return out;
		}
		renderDiffStatCard(theme, parsed, out, width); // success: summary line only (no -v rows)
		return out;
	}
	if (parsed.command === "pull") {
		if (parsed.status === "Already up to date.") {
			out.push(theme.fg("muted", "  Already up to date."));
			return out;
		}
		// Fast-forward: range + Fast-forward + diff-stat summary/rows.
		if (parsed.range) out.push(`  ${theme.fg("text", parsed.range)}`);
		out.push(`  ${theme.fg("accent", "Fast-forward")}`);
		renderDiffStatCard(theme, parsed, out, width);
		return out;
	}
	if (parsed.command === "push") {
		if (parsed.remote) out.push(theme.fg("dim", `  To ${parsed.remote}`));
		for (const ref of parsed.refs ?? []) out.push(safeTruncateToWidth(`  ${theme.fg("toolOutput", ref)}`, width, "…"));
		if (parsed.status) out.push(theme.fg("muted", `  ${parsed.status}`)); // Everything up-to-date
		return out;
	}
	if (parsed.command === "fetch") {
		if (parsed.status) {
			out.push(theme.fg("muted", `  ${parsed.status}`)); // no new refs (empty fetch)
			return out;
		}
		if (parsed.remote) out.push(theme.fg("dim", `  From ${parsed.remote}`));
		for (const ref of parsed.refs ?? []) out.push(safeTruncateToWidth(`  ${theme.fg("toolOutput", ref)}`, width, "…"));
		return out;
	}
	if (parsed.command === "merge") {
		if (parsed.status === "Already up to date.") {
			out.push(theme.fg("muted", "  Already up to date."));
			return out;
		}
		// Fast-forward / `Merge made by the '…' strategy.` + stat summary/rows.
		if (parsed.range) out.push(`  ${theme.fg("text", parsed.range)}`);
		if (parsed.status) out.push(`  ${theme.fg("accent", parsed.status)}`);
		renderDiffStatCard(theme, parsed, out, width);
		return out;
	}
	if (parsed.command === "reset") {
		// Mixed reset with unstaged changes: `M  path` rows (hash/subject live in
		// the header for --hard/--soft via `HEAD is now at`).
		if (parsed.resetFiles && parsed.resetFiles.length > 0) {
			return renderStatusFileRows(theme, parsed.resetFiles, out, width);
		}
		if (parsed.status) out.push(theme.fg("muted", `  ${parsed.status}`)); // completed, no output
		return out;
	}
	// switch/checkout (branch in the header), add/restore/rebase (status line).
	if (parsed.status) out.push(theme.fg("muted", `  ${parsed.status}`));
	return out;
}

// ── Dispatch helpers (used by bash.ts) ──────────────────────────────────────

export function parseGitOutput(cls: GitSemanticClass, output: string): GitParsedSemantic | null {
	const text = String(output ?? "");
	if (cls.kind === "status") return parseGitStatus(cls, text);
	if (cls.kind === "diff-stat") return parseGitDiffStat(text);
	if (cls.kind === "show-stat") return parseGitShowStat(text);
	if (cls.kind === "diff") return parseGitDiff(text, cls.show);
	if (cls.kind === "action") return parseGitAction(cls.command, text);
	return parseGitLog(text);
}

/**
 * Render the git semantic card for one call: the header always renders (so a
 * pending call shows a single summary line); once the result parses, counts,
 * file/commit rows, and the `… N more` collapse follow. Every line is
 * width-safe.
 */
export function renderGitCardLines(
	theme: BoxTheme,
	state: { readonly cls: GitSemanticClass; readonly parsed?: GitParsedSemantic },
	width: number,
): string[] {
	const safeWidth = Math.max(1, width);
	const out: string[] = [safeTruncateToWidth(gitCardHeader(theme, state.cls, state.parsed), safeWidth, "…")];
	const parsed = state.parsed;
	if (!parsed) return out;
	if (parsed.kind === "status") renderStatusCard(theme, parsed, out, safeWidth);
	else if (parsed.kind === "diff-stat") renderDiffStatCard(theme, parsed, out, safeWidth);
	else if (parsed.kind === "show-stat") renderDiffStatCard(theme, parsed, out, safeWidth);
	else if (parsed.kind === "diff") renderDiffCard(theme, parsed, out, safeWidth);
	else if (parsed.kind === "action") renderActionCard(theme, parsed, out, safeWidth);
	else renderLogCard(theme, parsed, out, safeWidth);
	return out.map((line) => safeTruncateToWidth(line, safeWidth, "…"));
}

// ── Boxed diff result (Phase 8B) ──────────────────────────────────────────
// `git diff` / `git show` results render one frame per file via
// `renderBoxedToolResult` + the same `AdaptiveDiffComponent` `Edit` uses — no
// second diff visual language (ADR 0005 / GIT-002). The Git header lives
// outside the box (the call panel card); each file gets its own `╭…╰` frame
// with a `Diff · +N -M` divider and a `Ctrl+O more` expand hint when collapsed.

const GIT_DIFF_MAX_HIGHLIGHT_CHARS = 12000;
const GIT_DIFF_MAX_HIGHLIGHT_ROWS = 120;
const GIT_DIFF_MAX_ROWS_COLLAPSED = 36;
const GIT_DIFF_MAX_ROWS_EXPANDED = 160;

function fileBoxTopLabel(theme: BoxTheme, path: string): string {
	const body = theme.fg("text", path);
	return typeof theme?.bold === "function" ? theme.bold(body) : body;
}

function binaryBodyLine(theme: BoxTheme, status: GitDiffFile["status"]): string {
	const verb =
		status === "added" ? "added" : status === "deleted" ? "removed" : status === "renamed" ? "renamed" : "changed";
	return theme.fg("muted", `Binary file ${verb} (content not shown)`);
}

interface DiffFileBox {
	readonly topLabel: string;
	readonly resultComponent: Component;
}

/** Build a complete boxed-diff result component for a parsed `git diff`/`show`.
 *  The call panel renders the boxless Git header; this component renders one
 *  `╭…╰` frame per file (or a single `No changes` frame for an empty diff). */
export function renderGitDiffResult(
	theme: BoxTheme,
	parsed: GitDiffParsed,
	options: { expanded: boolean },
	context: BoxedToolContext,
): Component {
	const expanded = Boolean(options.expanded);
	const elapsedMs = getStateElapsedMs(context.state);
	const fileCount = parsed.files.length;

	const footerParts: string[] = [];
	if (elapsedMs !== undefined) footerParts.push(theme.fg("text", formatElapsedMs(elapsedMs)));
	footerParts.push(theme.fg("dim", `${fileCount} ${pluralForm("file", fileCount)}`));
	const footer = footerParts.join(theme.fg("dim", " · "));

	const fileBoxes: DiffFileBox[] = [];
	if (parsed.files.length === 0) {
		// Empty diff (`git diff` with no changes): a single `No changes` frame so
		// the result is not a blank panel.
		const emptyFooterParts: string[] = [];
		if (elapsedMs !== undefined) emptyFooterParts.push(theme.fg("text", formatElapsedMs(elapsedMs)));
		const emptyFooter = emptyFooterParts.join(theme.fg("dim", " · "));
		fileBoxes.push({
			topLabel: fileBoxTopLabel(theme, parsed.show ? "Git show" : "Git diff"),
			resultComponent: renderBoxedToolResult(theme, () => [theme.fg("muted", "No changes")], {
				showDivider: false,
				footerLines: emptyFooter ? [emptyFooter] : [],
			}),
		});
	} else {
		for (const file of parsed.files) {
			const topLabel = fileBoxTopLabel(theme, file.path);
			if (file.binary) {
				fileBoxes.push({
					topLabel,
					resultComponent: renderBoxedToolResult(theme, () => [binaryBodyLine(theme, file.status)], {
						showDivider: false,
						footerLines: [footer],
					}),
				});
				continue;
			}
			const rows = buildSplitRows(file.body);
			const language = getLanguageFromPath(file.path);
			const shouldHighlight =
				Boolean(language) &&
				file.body.length <= GIT_DIFF_MAX_HIGHLIGHT_CHARS &&
				rows.length <= GIT_DIFF_MAX_HIGHLIGHT_ROWS;
			const maxRows = expanded ? GIT_DIFF_MAX_ROWS_EXPANDED : GIT_DIFF_MAX_ROWS_COLLAPSED;
			const view = new AdaptiveDiffComponent(theme, rows, maxRows, shouldHighlight ? language : undefined);
			const expandHint = !expanded && view.hasCollapsed() ? "Ctrl+O more" : undefined;
			fileBoxes.push({
				topLabel,
				resultComponent: renderBoxedToolResult(theme, view, {
					showDivider: false,
					footerLines: [footer],
					...(expandHint ? { expandHint } : {}),
				}),
			});
		}
	}

	let cacheWidth: number | undefined;
	let cacheLines: string[] | undefined;

	return {
		invalidate() {
			cacheWidth = undefined;
			cacheLines = undefined;
			for (const box of fileBoxes) box.resultComponent.invalidate();
		},
		render(width: number): string[] {
			if (cacheWidth === width && cacheLines) return cacheLines;
			const renderedWidth = boxWidth(width);
			const lines: string[] = [];
			for (const box of fileBoxes) {
				lines.push(boxLabeledBorder(theme, "╭", "╮", box.topLabel, undefined, renderedWidth));
				lines.push(boxBlankLine(theme, renderedWidth));
				lines.push(...box.resultComponent.render(width));
			}
			cacheWidth = width;
			cacheLines = dropOmittedLines(lines);
			return lines;
		},
	};
}

// GitHub (`gh`) semantic view renderer (Phase 8D).
//
// Bash `gh pr`/`issue`/`run` results render as a boxless compact card in the
// call panel, mirroring the git semantic path (see git.ts). `gh run view
// --job=<id>` renders the job log in a boxed result (the same
// `renderBoxedToolResult` shape git diff uses), while `gh run watch`, `gh api`,
// and any command with pipes/redirects/`&&` stay raw (ADR 0005). bash.ts owns
// the registry and dispatch; this module is registry-free pure functions.
//
// Every parser is fail-closed: on any ambiguity it returns null and the boxed
// command/response shell renders the raw output unchanged. `--json` output is
// detected by the first non-whitespace character (`{`/`[`); otherwise the
// table/rich text format is parsed.

import type { Component } from "@earendil-works/pi-tui";
import { type BoxTheme, dimLine, renderBoxedToolResult } from "../../../shared/box.js";
import { formatElapsedMs } from "../../../shared/elapsed.js";
import { safeTruncateToWidth } from "../../../shared/render-budget.js";
import { parseSimpleBashCommand } from "./command-shape.js";
import { pluralForm, TREE_INDENT } from "./output-tree.js";
import { getStateElapsedMs, getToolsRenderConfig } from "./session-config.js";
import type { BoxedToolContext } from "./shared.js";

// ── Classification ──────────────────────────────────────────────────────────

export type GhSemanticClass =
	| { readonly kind: "pr-list" }
	| { readonly kind: "pr-view" }
	| { readonly kind: "pr-checks" }
	| { readonly kind: "pr-create" }
	| { readonly kind: "issue-list" }
	| { readonly kind: "issue-view" }
	| { readonly kind: "run-list" }
	| { readonly kind: "run-view" }
	| { readonly kind: "run-job"; readonly jobId: string };

/** Global `gh` flags that consume a separate value token (`-R owner/repo`). */
const GH_REPO_VALUE_FLAGS = new Set(["-R", "--repo"]);

/** Strip `-R <value>` / `--repo <value>` (and attached `--repo=value`) pairs so
 *  the command/subcommand words can be located anywhere in the arg list. */
function stripRepoFlags(args: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; ) {
		const token = args[i] ?? "";
		if (GH_REPO_VALUE_FLAGS.has(token)) {
			i += 2; // flag + its value
			continue;
		}
		if (token.startsWith("--repo=")) {
			i += 1;
			continue;
		}
		out.push(token);
		i += 1;
	}
	return out;
}

/** Locate the `--job` value (`--job <id>` or `--job=<id>`) on a `run view`. */
function findJobId(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const token = args[i] ?? "";
		if (token === "--job") return args[i + 1];
		const attached = /^--job=(.+)$/.exec(token);
		if (attached) return attached[1];
	}
	return undefined;
}

/**
 * Classify a bash command for `gh` semantic rendering, or null to keep the
 * boxed shell. Only `gh pr {list,view,checks,create}`, `gh issue {list,view}`,
 * and `gh run {list,view}` are eligible; `gh run view --job=<id>` becomes a
 * `run-job` (boxed log). `gh run watch`, `gh api`, and any other subcommand or
 * pipe/redirect fall back raw (ADR 0005).
 */
export function classifyGhCommand(command: string): GhSemanticClass | null {
	const shape = parseSimpleBashCommand(command);
	if (!shape) return null;
	const rest = shape.tokens;
	if ((rest[0] ?? "").split("/").pop() !== "gh") return null;
	const args = rest.slice(1);
	if (args.length === 0) return null;

	const tokens = stripRepoFlags(args);
	const commandWord = tokens[0];
	const subcommand = tokens[1];

	if (commandWord === "pr") {
		if (subcommand === "list") return { kind: "pr-list" };
		if (subcommand === "view") return { kind: "pr-view" };
		if (subcommand === "checks") return { kind: "pr-checks" };
		if (subcommand === "create") return { kind: "pr-create" };
		return null;
	}
	if (commandWord === "issue") {
		if (subcommand === "list") return { kind: "issue-list" };
		if (subcommand === "view") return { kind: "issue-view" };
		return null;
	}
	if (commandWord === "run") {
		if (subcommand === "list") return { kind: "run-list" };
		if (subcommand === "view") {
			const jobId = findJobId(args);
			if (jobId !== undefined) return { kind: "run-job", jobId };
			return { kind: "run-view" };
		}
		// `gh run watch` and all other run subcommands stay raw (ADR 0005).
		return null;
	}
	return null; // `gh api`, extensions, and other subcommands
}

// ── Parsed shapes ───────────────────────────────────────────────────────────

const GH_STATES = new Set(["OPEN", "CLOSED", "MERGED"]);
const GH_CHECK_STATES = new Set([
	"pass",
	"fail",
	"pending",
	"skipping",
	"neutral",
	"cancelled",
	"timed_out",
	"startup_failure",
	"stale",
	"action_required",
]);

export interface GhListItem {
	readonly number: number;
	readonly title: string;
	readonly branch?: string;
	readonly state: string;
}

export interface GhListParsed {
	readonly kind: "pr-list" | "issue-list";
	readonly rows: readonly GhListItem[];
}

export interface GhViewParsed {
	readonly kind: "pr-view" | "issue-view";
	readonly title: string;
	readonly state: string;
	readonly author?: string;
	readonly number?: number;
	readonly url?: string;
	readonly additions?: number;
	readonly deletions?: number;
	readonly changedFiles?: number;
	readonly baseRefName?: string;
	readonly headRefName?: string;
	readonly reviewers?: string;
	readonly reviewDecision?: string;
	readonly mergeable?: string;
	readonly labels?: string;
	readonly body?: string;
}

export interface GhCheckRow {
	readonly name: string;
	readonly state: string;
	readonly duration?: string;
	readonly url?: string;
}

export interface GhChecksParsed {
	readonly kind: "pr-checks";
	readonly rows: readonly GhCheckRow[];
}

export interface GhCreateParsed {
	readonly kind: "pr-create";
	readonly url: string;
	readonly number?: number;
}

export interface GhRunListRow {
	readonly status: string;
	readonly conclusion?: string;
	readonly title: string;
	readonly workflow: string;
	readonly branch: string;
	readonly event: string;
	readonly id: string;
	readonly elapsed?: string;
}

export interface GhRunListParsed {
	readonly kind: "run-list";
	readonly rows: readonly GhRunListRow[];
}

export interface GhRunJob {
	readonly state: string;
	readonly name: string;
	readonly count?: number;
	readonly duration?: string;
	readonly id?: string;
}

export interface GhRunAnnotation {
	readonly text: string;
}

export interface GhRunViewParsed {
	readonly kind: "run-view";
	readonly state?: string;
	readonly branch?: string;
	readonly workflow?: string;
	readonly id?: string;
	readonly trigger?: string;
	readonly jobs: readonly GhRunJob[];
	readonly annotations: readonly GhRunAnnotation[];
}

export interface GhRunJobParsed {
	readonly kind: "run-job";
	readonly jobId: string;
	readonly lines: readonly string[];
}

export type GhParsedSemantic =
	| GhListParsed
	| GhViewParsed
	| GhChecksParsed
	| GhCreateParsed
	| GhRunListParsed
	| GhRunViewParsed
	| GhRunJobParsed;

// ── JSON detection ──────────────────────────────────────────────────────────

type JsonProbe = { readonly json: unknown } | { readonly notJson: true } | null;

/** Probe whether the text is `gh --json` output (starts with `{`/`[`). Returns
 *  `{json}` on a successful parse, `{notJson}` for table/rich text, or `null`
 *  when the text looks like JSON but fails to parse (hostile). */
function probeJson(text: string): JsonProbe {
	const trimmed = text.trimStart();
	const first = trimmed[0];
	if (first !== "{" && first !== "[") return { notJson: true };
	try {
		return { json: JSON.parse(trimmed) };
	} catch {
		return null;
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `author` may be a bare login string or `{ login }` (the `gh --json` shape). */
function authorOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") return asString((value as Record<string, unknown>).login);
	return undefined;
}

/** Join an array of `{ login }` / `{ name }` objects into a comma list. */
function nameList(value: unknown, field: "login" | "name" = "login"): string | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const names = value
		.map((item) => (item && typeof item === "object" ? asString((item as Record<string, unknown>)[field]) : undefined))
		.filter((name): name is string => typeof name === "string");
	return names.length > 0 ? names.join(", ") : undefined;
}

// ── list parsers (pr list / issue list) ─────────────────────────────────────
// Tab-separated default output. `gh pr list` columns are
// NUMBER<TAB>TITLE<TAB>BRANCH<TAB>STATE<TAB>UPDATED (5); `gh issue list` is
// NUMBER<TAB>TITLE<TAB>STATE<TAB>UPDATED (4) and may carry labels before STATE.
// The state token (OPEN/CLOSED/MERGED) is located by content so both shapes
// parse without a fixed column count.

function parseListTable(text: string, kind: "pr-list" | "issue-list"): GhListParsed | null {
	const rows: GhListItem[] = [];
	for (const rawLine of text.replace(/\r/g, "").split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") continue;
		const fields = line.split("\t");
		if (fields.length < 4) return null;
		const numberField = fields[0] ?? "";
		if (!/^\d+$/.test(numberField)) return null;
		const title = fields[1] ?? "";
		let stateIndex = -1;
		for (let i = 2; i < fields.length - 1; i++) {
			if (GH_STATES.has((fields[i] ?? "").toUpperCase())) {
				stateIndex = i;
				break;
			}
		}
		if (stateIndex < 0) return null;
		const state = (fields[stateIndex] ?? "").toUpperCase();
		const branch = kind === "pr-list" ? (fields[2] ?? "") : "";
		rows.push({
			number: Number(numberField),
			title,
			...(branch ? { branch } : {}),
			state,
		});
	}
	return { kind, rows };
}

function parseListJson(json: unknown, kind: "pr-list" | "issue-list"): GhListParsed | null {
	if (!Array.isArray(json)) return null;
	const rows: GhListItem[] = [];
	for (const item of json) {
		if (!item || typeof item !== "object") return null;
		const obj = item as Record<string, unknown>;
		const number = asNumber(obj.number);
		if (number === undefined) return null;
		const title = asString(obj.title);
		if (title === undefined) return null;
		const stateRaw = asString(obj.state);
		if (stateRaw === undefined || !GH_STATES.has(stateRaw.toUpperCase())) return null;
		const branch = asString(obj.headRefName);
		rows.push({ number, title, state: stateRaw.toUpperCase(), ...(branch ? { branch } : {}) });
	}
	return { kind, rows };
}

function parseGhList(text: string, kind: "pr-list" | "issue-list"): GhListParsed | null {
	const probe = probeJson(text);
	if (probe === null) return null;
	if ("notJson" in probe) return parseListTable(text, kind);
	return parseListJson(probe.json, kind);
}

// ── view parsers (pr view / issue view) ─────────────────────────────────────
// Rich output is a block of `key:\tvalue` pairs, a `--` separator, then the
// markdown body. `--json` is a single object (base/head/mergeable/changedFiles
// only appear in JSON; the rich block carries title/state/author/labels/
// reviewers/number/url/additions/deletions).

const VIEW_FIELD_LINE = /^([a-zA-Z][a-zA-Z0-9-]*?):\t(.*)$/;

function parseViewRich(text: string, kind: "pr-view" | "issue-view"): GhViewParsed | null {
	const lines = text.replace(/\r/g, "").split("\n");
	const fields: Record<string, string> = {};
	let bodyStart = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line === "--") {
			bodyStart = i + 1;
			break;
		}
		const match = VIEW_FIELD_LINE.exec(line);
		if (!match) {
			if (line.trim() === "") continue; // tolerate a stray blank line
			return null; // unrecognized line → fail closed
		}
		const key = match[1] ?? "";
		const value = match[2] ?? "";
		if (fields[key] === undefined) fields[key] = value;
	}
	const title = fields.title;
	const stateRaw = fields.state;
	if (!title || !stateRaw) return null;
	const state = stateRaw.toUpperCase();
	const body = bodyStart >= 0 ? lines.slice(bodyStart).join("\n").replace(/\s+$/u, "") : undefined;

	const number = /^\d+$/.test(fields.number ?? "") ? Number(fields.number) : undefined;
	const additions = /^\d+$/.test(fields.additions ?? "") ? Number(fields.additions) : undefined;
	const deletions = /^\d+$/.test(fields.deletions ?? "") ? Number(fields.deletions) : undefined;

	return {
		kind,
		title,
		state,
		...(fields.author ? { author: fields.author } : {}),
		...(number !== undefined ? { number } : {}),
		...(fields.url ? { url: fields.url } : {}),
		...(additions !== undefined ? { additions } : {}),
		...(deletions !== undefined ? { deletions } : {}),
		...(fields.labels ? { labels: fields.labels } : {}),
		...(fields.reviewers ? { reviewers: fields.reviewers } : {}),
		...(body?.trim() ? { body } : {}),
	};
}

function parseViewJson(json: unknown, kind: "pr-view" | "issue-view"): GhViewParsed | null {
	if (!json || typeof json !== "object" || Array.isArray(json)) return null;
	const o = json as Record<string, unknown>;
	const title = asString(o.title);
	const stateRaw = asString(o.state);
	if (!title || !stateRaw || !GH_STATES.has(stateRaw.toUpperCase())) return null;
	const state = stateRaw.toUpperCase();
	const author = authorOf(o.author);
	const number = asNumber(o.number);
	const url = asString(o.url);
	const additions = asNumber(o.additions);
	const deletions = asNumber(o.deletions);
	const changedFiles = asNumber(o.changedFiles);
	const baseRefName = asString(o.baseRefName);
	const headRefName = asString(o.headRefName);
	const mergeable = asString(o.mergeable);
	const reviewDecision = asString(o.reviewDecision);
	const reviewers = nameList(o.reviewRequests) ?? nameList(o.reviews);
	const body = asString(o.body);
	return {
		kind,
		title,
		state,
		...(author ? { author } : {}),
		...(number !== undefined ? { number } : {}),
		...(url ? { url } : {}),
		...(additions !== undefined ? { additions } : {}),
		...(deletions !== undefined ? { deletions } : {}),
		...(changedFiles !== undefined ? { changedFiles } : {}),
		...(baseRefName ? { baseRefName } : {}),
		...(headRefName ? { headRefName } : {}),
		...(mergeable ? { mergeable } : {}),
		...(reviewDecision ? { reviewDecision } : {}),
		...(reviewers ? { reviewers } : {}),
		...(body?.trim() ? { body } : {}),
	};
}

function parseGhView(text: string, kind: "pr-view" | "issue-view"): GhViewParsed | null {
	const probe = probeJson(text);
	if (probe === null) return null;
	if ("notJson" in probe) return parseViewRich(text, kind);
	return parseViewJson(probe.json, kind);
}

// ── pr checks parser ────────────────────────────────────────────────────────
// `NAME<TAB>STATE<TAB>DURATION<TAB>URL` (states: pass/fail/pending/skipping).

function parseChecksTable(text: string): GhChecksParsed | null {
	const rows: GhCheckRow[] = [];
	for (const rawLine of text.replace(/\r/g, "").split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") continue;
		const fields = line.split("\t");
		if (fields.length < 2) return null;
		const name = fields[0] ?? "";
		const state = (fields[1] ?? "").toLowerCase();
		if (!GH_CHECK_STATES.has(state)) return null;
		const duration = fields[2] !== undefined && fields[2] !== "" ? fields[2] : undefined;
		const url = fields[3];
		rows.push({
			name,
			state,
			...(duration ? { duration } : {}),
			...(url ? { url } : {}),
		});
	}
	return { kind: "pr-checks", rows };
}

// ── pr create parser ────────────────────────────────────────────────────────
// Success prints `https://github.com/<owner>/<repo>/pull/<N>`.

const PR_CREATE_URL = /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+))/;

function parseGhCreate(text: string): GhCreateParsed | null {
	const trimmed = text.replace(/\r/g, "").trim();
	const match = PR_CREATE_URL.exec(trimmed);
	if (!match) return null;
	const url = match[1] ?? "";
	const number = match[2] !== undefined ? Number(match[2]) : undefined;
	return { kind: "pr-create", url, ...(number !== undefined ? { number } : {}) };
}

// ── run list parser ─────────────────────────────────────────────────────────
// STATUS<TAB>CONCLUSION<TAB>TITLE<TAB>WORKFLOW<TAB>BRANCH<TAB>EVENT<TAB>ID<TAB>
// ELAPSED<TAB>AGE. JSON carries databaseId/headBranch/name/workflowName/event.

function parseRunListTable(text: string): GhRunListParsed | null {
	const rows: GhRunListRow[] = [];
	for (const rawLine of text.replace(/\r/g, "").split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") continue;
		const fields = line.split("\t");
		// Need at least STATUS..CONCLUSION..TITLE..WORKFLOW..BRANCH..EVENT..ID.
		if (fields.length < 7) return null;
		const id = fields[6] ?? "";
		if (!/^\d+$/.test(id)) return null;
		const status = fields[0] ?? "";
		const conclusionField = fields[1] ?? "";
		const conclusion = conclusionField !== "" ? conclusionField : undefined;
		const title = fields[2] ?? "";
		const workflow = fields[3] ?? "";
		const branch = fields[4] ?? "";
		const event = fields[5] ?? "";
		const elapsed = fields[7] !== undefined && fields[7] !== "" ? fields[7] : undefined;
		rows.push({
			status,
			...(conclusion ? { conclusion } : {}),
			title,
			workflow,
			branch,
			event,
			id,
			...(elapsed ? { elapsed } : {}),
		});
	}
	return { kind: "run-list", rows };
}

function parseRunListJson(json: unknown): GhRunListParsed | null {
	if (!Array.isArray(json)) return null;
	const rows: GhRunListRow[] = [];
	for (const item of json) {
		if (!item || typeof item !== "object") return null;
		const o = item as Record<string, unknown>;
		const status = asString(o.status);
		const id = asNumber(o.databaseId ?? o.id);
		if (status === undefined || id === undefined) return null;
		const workflow = asString(o.workflowName) ?? asString(o.name) ?? "";
		const title = asString(o.displayTitle) ?? workflow;
		rows.push({
			status,
			...(asString(o.conclusion) ? { conclusion: asString(o.conclusion) as string } : {}),
			title,
			workflow,
			branch: asString(o.headBranch) ?? "",
			event: asString(o.event) ?? "",
			id: String(id),
			...(asString(o.elapsed) ? { elapsed: o.elapsed as string } : {}),
		});
	}
	return { kind: "run-list", rows };
}

function parseGhRunList(text: string): GhRunListParsed | null {
	const probe = probeJson(text);
	if (probe === null) return null;
	if ("notJson" in probe) return parseRunListTable(text);
	return parseRunListJson(probe.json);
}

// ── run view parser ─────────────────────────────────────────────────────────
// Rich output: a status line `✓|✘|◌ <branch> <workflow> · <id>`, an optional
// `Triggered via …` line, a `JOBS` block of `✓|✘|◌ <name> (N) in <dur> (ID id)`
// rows, an optional `ANNOTATIONS` block of `! …` rows, then trailing hint
// lines (`For more information…`, `View this run on GitHub:…`) which are skipped.

const RUN_VIEW_STATUS_LINE = /^([✓✘◌*])\s+(\S+)\s+(.+?)\s+·\s+(\d+)\s*$/u;
const RUN_VIEW_JOB_LINE = /^([✓✘◌*])\s+(.+?)\s+\((\d+)\)\s+in\s+(\S+)\s+\(ID\s+(\d+)\)\s*$/u;

function isRunViewHint(line: string): boolean {
	return line.startsWith("For more information about the job, try:") || line.startsWith("View this run on GitHub:");
}

function parseGhRunView(text: string): GhRunViewParsed | null {
	const lines = text.replace(/\r/g, "").split("\n");
	let idx = 0;
	while (idx < lines.length && (lines[idx] ?? "").trim() === "") idx++;
	if (idx >= lines.length) return null;

	const statusMatch = RUN_VIEW_STATUS_LINE.exec(lines[idx] ?? "");
	if (!statusMatch) return null;
	const state = statusMatch[1] ?? "";
	const branch = statusMatch[2] ?? "";
	const workflow = statusMatch[3] ?? "";
	const id = statusMatch[4] ?? "";
	idx++;

	// Optional `Triggered via …` line.
	let trigger: string | undefined;
	while (idx < lines.length && (lines[idx] ?? "").trim() === "") idx++;
	if (idx < lines.length && /^Triggered via .+/.test(lines[idx] ?? "")) {
		trigger = lines[idx];
		idx++;
	}

	const jobs: GhRunJob[] = [];
	const annotations: GhRunAnnotation[] = [];

	const skipBlanks = () => {
		while (idx < lines.length && (lines[idx] ?? "").trim() === "") idx++;
	};

	skipBlanks();
	if ((lines[idx] ?? "") === "JOBS") {
		idx++;
		while (idx < lines.length) {
			const line = lines[idx] ?? "";
			if (line === "") {
				idx++;
				break;
			}
			if (line === "ANNOTATIONS" || isRunViewHint(line)) break;
			const jobMatch = RUN_VIEW_JOB_LINE.exec(line);
			if (!jobMatch) return null;
			jobs.push({
				state: jobMatch[1] ?? "",
				name: jobMatch[2] ?? "",
				count: Number(jobMatch[3] ?? 0),
				duration: jobMatch[4] ?? "",
				id: jobMatch[5] ?? "",
			});
			idx++;
		}
	}

	skipBlanks();
	if ((lines[idx] ?? "") === "ANNOTATIONS") {
		idx++;
		while (idx < lines.length) {
			const line = lines[idx] ?? "";
			if (line === "") {
				idx++;
				break;
			}
			if (isRunViewHint(line)) break;
			const annotationMatch = /^!\s+(.+)$/.exec(line);
			if (annotationMatch) {
				annotations.push({ text: annotationMatch[1] ?? "" });
				idx++;
				continue;
			}
			// Location-reference row following a `! …` message (`check (22):
			// .github#2`) — a dim source pointer, not a new annotation.
			const sourceMatch = /^[A-Za-z0-9_ ./()-]+\(\d+\): \S+#\d+$/.exec(line);
			if (sourceMatch) {
				annotations.push({ text: line });
				idx++;
				continue;
			}
			return null;
		}
	}

	// Only hint/blank lines may follow; anything else fails closed.
	for (let i = idx; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "") continue;
		if (isRunViewHint(line)) continue;
		return null;
	}

	return {
		kind: "run-view",
		...(state ? { state } : {}),
		...(branch ? { branch } : {}),
		...(workflow ? { workflow } : {}),
		...(id ? { id } : {}),
		...(trigger ? { trigger } : {}),
		jobs,
		annotations,
	};
}

// ── run job parser ──────────────────────────────────────────────────────────
// The job log is raw text; any output is a valid log body (the boxed result
// owns width-truncation and a render budget). It never fails closed.

function parseGhRunJob(text: string, jobId: string): GhRunJobParsed {
	const body = String(text ?? "").replace(/\r/g, "");
	const lines = body.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return { kind: "run-job", jobId, lines };
}

// ── Dispatch helpers (used by bash.ts) ──────────────────────────────────────

export function parseGhOutput(cls: GhSemanticClass, output: string): GhParsedSemantic | null {
	const text = String(output ?? "");
	switch (cls.kind) {
		case "pr-list":
			return parseGhList(text, "pr-list");
		case "issue-list":
			return parseGhList(text, "issue-list");
		case "pr-view":
			return parseGhView(text, "pr-view");
		case "issue-view":
			return parseGhView(text, "issue-view");
		case "pr-checks":
			return parseChecksTable(text);
		case "pr-create":
			return parseGhCreate(text);
		case "run-list":
			return parseGhRunList(text);
		case "run-view":
			return parseGhRunView(text);
		case "run-job":
			return parseGhRunJob(text, cls.jobId);
	}
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** Nerd Font GitHub mark glyph used on gh card headers in Nerd Font mode. */
export const GH_ICON = "\u{F408}";

const GH_CARD_HEAD_LIMIT = 6;
const GH_BODY_PREVIEW_LINES = 8;

function ghCardHeader(theme: BoxTheme, cls: GhSemanticClass, parsed?: GhParsedSemantic): string {
	const icon = getToolsRenderConfig().nerdFonts ? `${GH_ICON} ` : "";
	let prefix: string;
	switch (cls.kind) {
		case "pr-list":
			prefix = `${icon}PRs`;
			break;
		case "pr-view":
			prefix = `${icon}PR`;
			break;
		case "pr-checks":
			prefix = `${icon}PR checks`;
			break;
		case "pr-create":
			prefix = `${icon}PR created`;
			break;
		case "issue-list":
			prefix = `${icon}Issues`;
			break;
		case "issue-view":
			prefix = `${icon}Issue`;
			break;
		case "run-list":
			prefix = `${icon}Runs`;
			break;
		case "run-view":
			prefix = `${icon}Run`;
			break;
		case "run-job":
			prefix = `${icon}Run job`;
			break;
	}
	if (parsed) {
		if (parsed.kind === "pr-view" || parsed.kind === "issue-view") {
			if (parsed.number !== undefined) prefix += ` #${parsed.number}`;
			prefix += ` · ${parsed.title}`;
		} else if (parsed.kind === "pr-create") {
			if (parsed.number !== undefined) prefix += ` #${parsed.number}`;
		} else if (parsed.kind === "run-view") {
			if (parsed.workflow) prefix += ` · ${parsed.workflow}`;
			if (parsed.id) prefix += ` · ${parsed.id}`;
		} else if (parsed.kind === "run-job") {
			prefix += ` · ${parsed.jobId}`;
		}
	}
	return typeof theme?.bold === "function" ? theme.bold(prefix) : prefix;
}

/** State color for an OPEN/CLOSED/MERGED value. */
function ghStateColor(state: string): string {
	if (state === "OPEN") return "accent";
	if (state === "MERGED") return "toolDiffAdded";
	return "dim"; // CLOSED
}

/** Colored run glyph from a status/conclusion pair (✓ success, ✘ failure,
 *  ◌ in-progress/queued, dim for skipped/cancelled). */
function runGlyph(theme: BoxTheme, status: string, conclusion?: string): string {
	if (status === "completed") {
		if (conclusion === "success") return theme.fg("toolDiffAdded", "✓");
		if (conclusion === "failure") return theme.fg("error", "✘");
		return theme.fg("dim", "◌"); // cancelled / skipped / neutral
	}
	return theme.fg("warning", "◌"); // in_progress / queued / waiting
}

/** Colored run glyph from a raw ✓/✘/◌ token (run-view jobs). */
function runStateGlyph(theme: BoxTheme, glyph: string): string {
	if (glyph === "✓") return theme.fg("toolDiffAdded", "✓");
	if (glyph === "✘") return theme.fg("error", "✘");
	return theme.fg("warning", "◌");
}

/** Check-state color (pass/fail/pending/skipping/…). */
function checkStateColor(state: string): string {
	if (state === "pass") return "toolDiffAdded";
	if (state === "fail") return "error";
	if (state === "pending") return "warning";
	return "dim"; // skipping / neutral / cancelled / …
}

function renderMoreRow(theme: BoxTheme, unit: string, more: number, width: number): string {
	return safeTruncateToWidth(
		`${TREE_INDENT}${dimLine("└─")} ${theme.fg("dim", `… ${more} more ${pluralForm(unit, more)}`)}`,
		width,
		"…",
	);
}

function renderListCard(theme: BoxTheme, parsed: GhListParsed, out: string[], width: number): string[] {
	const rows = parsed.rows;
	const noun = parsed.kind === "pr-list" ? "PR" : "issue";
	if (rows.length === 0) {
		out.push(theme.fg("muted", `  no open ${pluralForm(noun, 2)}`));
		return out;
	}
	out.push(`  ${theme.fg("accent", `${rows.length} ${pluralForm(noun, rows.length)}`)}`);

	const visible = rows.slice(0, GH_CARD_HEAD_LIMIT);
	const more = rows.length - visible.length;
	const lastIndex = visible.length - 1;
	for (let i = 0; i < visible.length; i++) {
		const row = visible[i];
		if (!row) continue;
		const branchGlyph = i < lastIndex || more > 0 ? "├─" : "└─";
		const color = ghStateColor(row.state);
		const num = theme.fg(color, `#${row.number}`);
		const title = theme.fg("toolOutput", row.title);
		const stateSuffix = row.state !== "OPEN" ? theme.fg("dim", ` (${row.state.toLowerCase()})`) : "";
		const branchPart = row.branch ? theme.fg("dim", `  ${row.branch}`) : "";
		const line = `${TREE_INDENT}${dimLine(branchGlyph)} ${num}  ${title}${stateSuffix}${branchPart}`;
		out.push(safeTruncateToWidth(line, width, "…"));
	}
	if (more > 0) out.push(renderMoreRow(theme, noun, more, width));
	return out;
}

function renderBodyPreview(theme: BoxTheme, body: string, out: string[], width: number): string[] {
	const bodyLines = body.replace(/\s+$/u, "").split("\n");
	const visible = bodyLines.slice(0, GH_BODY_PREVIEW_LINES);
	for (const line of visible) {
		out.push(safeTruncateToWidth(`  ${theme.fg("muted", line)}`, width, "…"));
	}
	const more = bodyLines.length - visible.length;
	if (more > 0) {
		out.push(safeTruncateToWidth(`  ${theme.fg("dim", `… ${more} more lines · Ctrl+O`)}`, width, "…"));
	}
	return out;
}

function renderViewCard(theme: BoxTheme, parsed: GhViewParsed, out: string[], width: number): string[] {
	const stateParts = [theme.fg(ghStateColor(parsed.state), parsed.state)];
	if (parsed.baseRefName && parsed.headRefName) {
		stateParts.push(theme.fg("dim", "·"), theme.fg("text", `${parsed.baseRefName} → ${parsed.headRefName}`));
	}
	out.push(safeTruncateToWidth(`  ${stateParts.join(theme.fg("dim", " "))}`, width, "…"));

	const summaryParts: string[] = [];
	const diffParts: string[] = [];
	if (parsed.additions !== undefined && parsed.additions > 0) {
		diffParts.push(theme.fg("toolDiffAdded", `+${parsed.additions}`));
	}
	if (parsed.deletions !== undefined && parsed.deletions > 0) {
		diffParts.push(theme.fg("toolDiffRemoved", `-${parsed.deletions}`));
	}
	if (diffParts.length > 0) summaryParts.push(diffParts.join(" "));
	if (parsed.changedFiles !== undefined) {
		summaryParts.push(theme.fg("accent", `${parsed.changedFiles} ${pluralForm("file", parsed.changedFiles)}`));
	}
	if (summaryParts.length > 0) {
		out.push(safeTruncateToWidth(`  ${summaryParts.join(theme.fg("dim", " · "))}`, width, "…"));
	}

	if (parsed.author) {
		out.push(safeTruncateToWidth(`  ${theme.fg("dim", "author")} ${theme.fg("text", parsed.author)}`, width, "…"));
	}
	if (parsed.reviewers) {
		out.push(
			safeTruncateToWidth(`  ${theme.fg("dim", "reviewers")} ${theme.fg("toolOutput", parsed.reviewers)}`, width, "…"),
		);
	} else if (parsed.reviewDecision) {
		out.push(
			safeTruncateToWidth(`  ${theme.fg("dim", "review")} ${theme.fg("text", parsed.reviewDecision)}`, width, "…"),
		);
	}
	if (parsed.mergeable) {
		out.push(
			safeTruncateToWidth(`  ${theme.fg("dim", "mergeable")} ${theme.fg("text", parsed.mergeable)}`, width, "…"),
		);
	}
	if (parsed.body?.trim()) renderBodyPreview(theme, parsed.body, out, width);
	return out;
}

function renderChecksCard(theme: BoxTheme, parsed: GhChecksParsed, out: string[], width: number): string[] {
	const rows = parsed.rows;
	if (rows.length === 0) {
		out.push(theme.fg("muted", "  no checks reported"));
		return out;
	}
	const visible = rows.slice(0, GH_CARD_HEAD_LIMIT);
	const more = rows.length - visible.length;
	const lastIndex = visible.length - 1;
	for (let i = 0; i < visible.length; i++) {
		const row = visible[i];
		if (!row) continue;
		const branchGlyph = i < lastIndex || more > 0 ? "├─" : "└─";
		const name = theme.fg("toolOutput", row.name);
		const state = theme.fg(checkStateColor(row.state), row.state);
		const duration = row.duration && row.duration !== "0" ? theme.fg("dim", `  ${row.duration}`) : "";
		const line = `${TREE_INDENT}${dimLine(branchGlyph)} ${name}  ${state}${duration}`;
		out.push(safeTruncateToWidth(line, width, "…"));
	}
	if (more > 0) out.push(renderMoreRow(theme, "check", more, width));
	return out;
}

function renderCreateCard(theme: BoxTheme, parsed: GhCreateParsed, out: string[], width: number): string[] {
	out.push(safeTruncateToWidth(`  ${theme.fg("text", parsed.url)}`, width, "…"));
	return out;
}

function renderRunListCard(theme: BoxTheme, parsed: GhRunListParsed, out: string[], width: number): string[] {
	const rows = parsed.rows;
	if (rows.length === 0) {
		out.push(theme.fg("muted", "  no recent runs"));
		return out;
	}
	const visible = rows.slice(0, GH_CARD_HEAD_LIMIT);
	const more = rows.length - visible.length;
	const lastIndex = visible.length - 1;
	for (let i = 0; i < visible.length; i++) {
		const row = visible[i];
		if (!row) continue;
		const branchGlyph = i < lastIndex || more > 0 ? "├─" : "└─";
		const glyph = runGlyph(theme, row.status, row.conclusion);
		const workflow = theme.fg("text", row.workflow || row.title);
		const branch = theme.fg("dim", `  ${row.branch}`);
		const id = theme.fg("dim", `  ${row.id}`);
		const line = `${TREE_INDENT}${dimLine(branchGlyph)} ${glyph} ${workflow}${branch}${id}`;
		out.push(safeTruncateToWidth(line, width, "…"));
	}
	if (more > 0) out.push(renderMoreRow(theme, "run", more, width));
	return out;
}

function renderRunViewCard(theme: BoxTheme, parsed: GhRunViewParsed, out: string[], width: number): string[] {
	if (parsed.trigger) {
		out.push(safeTruncateToWidth(`  ${theme.fg("dim", parsed.trigger)}`, width, "…"));
	}
	const visibleJobs = parsed.jobs.slice(0, GH_CARD_HEAD_LIMIT);
	const moreJobs = parsed.jobs.length - visibleJobs.length;
	const lastJobIndex = visibleJobs.length - 1;
	for (let i = 0; i < visibleJobs.length; i++) {
		const job = visibleJobs[i];
		if (!job) continue;
		const branchGlyph = i < lastJobIndex || moreJobs > 0 || parsed.annotations.length > 0 ? "├─" : "└─";
		const glyph = runStateGlyph(theme, job.state);
		const name = theme.fg("toolOutput", `${job.name}${job.count !== undefined ? ` (${job.count})` : ""}`);
		const detail = theme.fg("dim", `${job.duration ? ` ${job.duration}` : ""}${job.id ? ` · ${job.id}` : ""}`);
		const line = `${TREE_INDENT}${dimLine(branchGlyph)} ${glyph} ${name}${detail}`;
		out.push(safeTruncateToWidth(line, width, "…"));
	}
	if (moreJobs > 0) out.push(renderMoreRow(theme, "job", moreJobs, width));
	for (let i = 0; i < parsed.annotations.length; i++) {
		const annotation = parsed.annotations[i];
		if (!annotation) continue;
		const branchGlyph = i < parsed.annotations.length - 1 ? "├─" : "└─";
		const line = `${TREE_INDENT}${dimLine(branchGlyph)} ${theme.fg("warning", "!")} ${theme.fg("dim", annotation.text)}`;
		out.push(safeTruncateToWidth(line, width, "…"));
	}
	return out;
}

/**
 * Render the gh semantic card for one call: the header always renders (so a
 * pending call shows a single summary line); once the result parses, counts,
 * rows, and a body preview follow. `run-job` renders its header here while the
 * log body lives in the boxed result. Every line is width-safe.
 */
export function renderGhCardLines(
	theme: BoxTheme,
	state: { readonly cls: GhSemanticClass; readonly parsed?: GhParsedSemantic },
	width: number,
): string[] {
	const safeWidth = Math.max(1, width);
	const out: string[] = [safeTruncateToWidth(ghCardHeader(theme, state.cls, state.parsed), safeWidth, "…")];
	const parsed = state.parsed;
	if (!parsed) return out;
	if (parsed.kind === "pr-list" || parsed.kind === "issue-list") renderListCard(theme, parsed, out, safeWidth);
	else if (parsed.kind === "pr-view" || parsed.kind === "issue-view") renderViewCard(theme, parsed, out, safeWidth);
	else if (parsed.kind === "pr-checks") renderChecksCard(theme, parsed, out, safeWidth);
	else if (parsed.kind === "pr-create") renderCreateCard(theme, parsed, out, safeWidth);
	else if (parsed.kind === "run-list") renderRunListCard(theme, parsed, out, safeWidth);
	else if (parsed.kind === "run-view") renderRunViewCard(theme, parsed, out, safeWidth);
	// run-job: header only — the log body renders in the boxed result.
	return out.map((line) => safeTruncateToWidth(line, safeWidth, "…"));
}

// ── Boxed run-job log result (Phase 8D) ────────────────────────────────────
// `gh run view --job=<id>` log output renders in a `renderBoxedToolResult`
// frame with a `Log · <job-id>` divider and an elapsed footer, mirroring the
// git diff boxed result. The call panel renders the boxless `Run job · <id>`
// header; the log body lives in the box. A render budget bounds very long logs
// (collapsed/expanded), and `renderBoxedToolResult` width-truncates each line.

const GH_RUN_JOB_BUDGET_COLLAPSED = 40;
const GH_RUN_JOB_BUDGET_EXPANDED = 200;

/** Build a complete boxed-log result component for a parsed `gh run view --job`. */
export function renderGhRunJobResult(
	theme: BoxTheme,
	parsed: GhRunJobParsed,
	options: { expanded: boolean },
	context: BoxedToolContext,
): Component {
	const expanded = Boolean(options.expanded);
	const elapsedMs = getStateElapsedMs(context.state);
	const footerParts: string[] = [];
	if (elapsedMs !== undefined) footerParts.push(theme.fg("text", formatElapsedMs(elapsedMs)));
	const footer = footerParts.join(theme.fg("dim", " · "));
	const hasLog = parsed.lines.some((line) => line.trim() !== "");
	const budget = expanded ? GH_RUN_JOB_BUDGET_EXPANDED : GH_RUN_JOB_BUDGET_COLLAPSED;
	return renderBoxedToolResult(
		theme,
		() => (hasLog ? parsed.lines.map((line) => theme.fg("toolOutput", line)) : [theme.fg("muted", "No log output")]),
		{
			dividerLabel: `Log · ${parsed.jobId}`,
			footerLines: footer ? [footer] : [],
			renderLineBudget: budget,
		},
	);
}

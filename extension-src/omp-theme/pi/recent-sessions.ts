// Recent sessions for the welcome card.
//
// Pi's extension API exposes only the *current* session (ReadonlySessionManager
// is a Pick over the live manager), so the list is read from the session
// directory Pi itself writes: one folder per project, one timestamped `.jsonl`
// per session whose first lines carry the header and the opening user message.
//
// Everything here is best-effort and bounded: a welcome screen must never be
// the reason a session fails to start, and it must not stat a large history.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RecentSession {
	/** Display title: the session's opening request, trimmed to one line. */
	readonly name: string;
	/** Relative age, e.g. `5h ago`. */
	readonly timeAgo: string;
}

/** How many files to read. Each costs one open; the card shows at most four. */
const SCAN_LIMIT = 6;
/** Enough to reach the first user message without reading a long transcript. */
const HEAD_BYTES = 8192;
const MAX_NAME_LENGTH = 72;

function formatAge(fromMs: number, nowMs: number): string {
	const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return `${Math.round(days / 30)}mo ago`;
}

/** First line of prose from a session's opening user message. */
function titleFrom(head: string): string | undefined {
	for (const line of head.split("\n")) {
		if (!line.startsWith("{")) continue;
		let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			// A truncated final line is expected: the read stops mid-file.
			continue;
		}
		const message = entry.message;
		if (!message || message.role !== "user") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text")
							.map((part) => String((part as { text?: unknown }).text ?? ""))
							.join(" ")
					: "";
		// Skip pasted context and command invocations: neither names the session.
		const first = text
			.split("\n")
			.map((value) => value.trim())
			.find((value) => value.length > 0 && !value.startsWith("<") && !value.startsWith("/"));
		if (first) return first.length > MAX_NAME_LENGTH ? `${first.slice(0, MAX_NAME_LENGTH - 1)}…` : first;
	}
	return undefined;
}

/**
 * The most recent sessions for this project, newest first, excluding the one
 * currently running.
 *
 * `sessionFile` is the live session's path — its directory is the project's
 * session folder. Returns an empty list rather than throwing on any I/O
 * problem; the card simply shows nothing.
 */
export function readRecentSessions(
	sessionFile: string | undefined,
	limit: number,
    nowMs: number = Date.now(),
): RecentSession[] {
	if (!sessionFile || limit <= 0) return [];
	try {
		const directory = dirname(sessionFile);
		// Filenames lead with an ISO creation timestamp, but the age shown is the
		// last write — ordering by name would print an older-looking entry above a
		// newer one. Take a bounded candidate set by name, then order by mtime so
		// the list agrees with the ages beside it.
		const candidates = readdirSync(directory)
			.filter((name) => name.endsWith(".jsonl") && !sessionFile.endsWith(name))
			.sort()
			.reverse()
			.slice(0, SCAN_LIMIT)
			.map((name) => {
				const path = join(directory, name);
				let modified = 0;
				try {
					modified = statSync(path).mtimeMs;
				} catch {
					// Unreadable: sorts last and is dropped below if it stays unreadable.
				}
				return { path, modified };
			})
			.sort((a, b) => b.modified - a.modified);

		const sessions: RecentSession[] = [];
		for (const candidate of candidates) {
			if (sessions.length >= limit) break;
			let head = "";
			try {
				head = readFileSync(candidate.path, "utf8").slice(0, HEAD_BYTES);
			} catch {
				continue;
			}
			const title = titleFrom(head);
			if (!title) continue;
			sessions.push({ name: title, timeAgo: formatAge(candidate.modified || nowMs, nowMs) });
		}
		return sessions;
	} catch {
		return [];
	}
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	ContextProvider,
	GitCommandResult,
	GitCommandRunner,
	GitProvider,
	UsageProvider,
} from "../domain/providers.js";
import type { ContextSnapshot, GitSnapshot, UsageSnapshot } from "../domain/status.js";

const execFileAsync = promisify(execFile);
const EMPTY_USAGE: UsageSnapshot = Object.freeze({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	streaming: false,
	subscriptionMode: "unknown",
});

export class NodeGitCommandRunner implements GitCommandRunner {
	async run(args: readonly string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<GitCommandResult> {
		if (signal?.aborted) return { stdout: "", stderr: "git command aborted", code: 1 };
		try {
			const result = await execFileAsync("git", [...args], {
				cwd,
				timeout: timeoutMs,
				maxBuffer: 1024 * 1024,
				signal,
			});
			return { stdout: result.stdout, stderr: result.stderr, code: 0 };
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string; code?: number; signal?: string };
			return {
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? (failure.signal ? `git terminated by ${failure.signal}` : "git command failed"),
				code: failure.code ?? 1,
			};
		}
	}
}

interface GitEntry {
	value: GitSnapshot;
	expiresAt: number;
	retryAt: number;
	generation: number;
	promise?: Promise<GitSnapshot>;
	controller?: AbortController;
	needsRefresh?: boolean;
	resultReady: boolean;
}

export interface GitProviderStats {
	readonly entries: number;
	readonly inFlight: number;
	readonly refreshes: number;
	readonly disposed: boolean;
}

export interface GitProviderClock {
	now(): number;
}

export class CachedGitProvider implements GitProvider {
	private readonly cache = new Map<string, GitEntry>();
	private disposed = false;
	private refreshCount = 0;
	constructor(
		private readonly runner: GitCommandRunner = new NodeGitCommandRunner(),
		private readonly ttlMs = 1000,
		private readonly timeoutMs = 800,
		private readonly maxBackoffMs = 5000,
		private readonly clock: GitProviderClock = { now: () => Date.now() },
	) {}
	get stats(): GitProviderStats {
		return {
			entries: this.cache.size,
			inFlight: [...this.cache.values()].filter((entry) => entry.promise).length,
			refreshes: this.refreshCount,
			disposed: this.disposed,
		};
	}
	async get(cwd: string): Promise<GitSnapshot> {
		if (this.disposed) return unavailableGit("provider disposed");
		const now = this.clock.now();
		const current = this.cache.get(cwd);
		if (current && current.expiresAt > now && !current.needsRefresh) return current.value;
		if (current?.promise) return current.resultReady ? current.value : current.promise;
		if (current && current.retryAt > now) return current.value;
		const stale = current?.value;
		const entry: GitEntry = current ?? {
			value: refreshingGit(),
			expiresAt: 0,
			retryAt: 0,
			generation: 0,
			resultReady: false,
		};
		entry.needsRefresh = false;
		entry.resultReady = Boolean(stale);
		entry.value = stale ? { ...stale, refreshing: true } : refreshingGit();
		entry.controller = new AbortController();
		entry.promise = this.refresh(cwd, entry, stale, entry.controller.signal);
		this.cache.set(cwd, entry);
		return stale ? entry.value : entry.promise;
	}
	invalidate(cwd?: string): void {
		const keys = cwd === undefined ? [...this.cache.keys()] : [cwd];
		for (const key of keys) {
			const entry = this.cache.get(key);
			if (!entry) continue;
			entry.generation++;
			entry.expiresAt = 0;
			if (entry.promise) entry.needsRefresh = true;
			else this.cache.delete(key);
		}
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of this.cache.values()) entry.controller?.abort();
		this.cache.clear();
	}
	private async refresh(
		cwd: string,
		entry: GitEntry,
		stale: GitSnapshot | undefined,
		signal: AbortSignal,
	): Promise<GitSnapshot> {
		this.refreshCount++;
		const generation = entry.generation;
		let value: GitSnapshot;
		try {
			const result = await this.runner.run(["status", "--porcelain=v1", "--branch"], cwd, this.timeoutMs, signal);
			if (result.code !== 0) {
				value = stale
					? { ...stale, refreshing: false, error: result.stderr.trim() || "git status failed" }
					: unavailableGit(result.stderr.trim() || "git status failed");
			} else value = parseGitStatus(result.stdout);
		} catch (error) {
			value = stale ? { ...stale, refreshing: false, error: String(error) } : unavailableGit(String(error));
		}
		if (this.disposed || this.cache.get(cwd) !== entry) return value;
		const invalidated = entry.generation !== generation || entry.needsRefresh;
		delete entry.promise;
		delete entry.controller;
		entry.value = value;
		entry.resultReady = true;
		if (invalidated) {
			entry.needsRefresh = false;
			entry.expiresAt = 0;
			void this.get(cwd);
			return value;
		}
		entry.retryAt = value.error ? this.clock.now() + Math.min(this.maxBackoffMs, Math.max(this.ttlMs, 100)) : 0;
		entry.expiresAt = this.clock.now() + this.ttlMs;
		if (entry.needsRefresh) {
			entry.needsRefresh = false;
			void this.get(cwd);
		}
		return value;
	}
}

function refreshingGit(): GitSnapshot {
	return Object.freeze({ available: false, branch: null, staged: 0, unstaged: 0, untracked: 0, refreshing: true });
}
function unavailableGit(error: string): GitSnapshot {
	return Object.freeze({
		available: false,
		branch: null,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		refreshing: false,
		error,
	});
}
export function parseGitStatus(output: string): GitSnapshot {
	const lines = output.split("\n").filter(Boolean);
	const header = lines.find((line) => line.startsWith("## "))?.slice(3) ?? "";
	if (!header) return unavailableGit("not a git repository");
	const branch = header.split("...")[0]?.replace(/^HEAD \(no branch\)$/, "detached") ?? null;
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	for (const line of lines) {
		if (line.startsWith("## ")) continue;
		if (line.startsWith("??")) {
			untracked++;
			continue;
		}
		if (line.length < 2) continue;
		if (line[0] !== " ") staged++;
		if (line[1] !== " ") unstaged++;
	}
	const ahead = /\[ahead (\d+)\]/.exec(header)?.[1];
	const behind = /\[behind (\d+)\]/.exec(header)?.[1];
	return Object.freeze({
		available: true,
		branch: branch || null,
		staged,
		unstaged,
		untracked,
		...(ahead ? { ahead: Number(ahead) } : {}),
		...(behind ? { behind: Number(behind) } : {}),
		refreshing: false,
	});
}

export class InMemoryUsageProvider implements UsageProvider {
	private readonly values = new Map<string, UsageSnapshot>();
	private readonly events = new Map<string, Set<string>>();
	private readonly finalized = new Map<string, Set<string>>();
	get(sessionId: string): UsageSnapshot {
		return this.values.get(sessionId) ?? EMPTY_USAGE;
	}
	record(
		sessionId: string,
		usage: Partial<UsageSnapshot>,
		options: { eventId?: string; finalized?: boolean } = {},
	): void {
		if (options.eventId) {
			const ids = this.events.get(sessionId) ?? new Set<string>();
			const finalized = this.finalized.get(sessionId) ?? new Set<string>();
			if (finalized.has(options.eventId) || (ids.has(options.eventId) && !options.finalized)) return;
			ids.add(options.eventId);
			this.events.set(sessionId, ids);
			if (options.finalized) {
				finalized.add(options.eventId);
				this.finalized.set(sessionId, finalized);
			}
		}
		const current = this.get(sessionId);
		const next = {
			...current,
			...usage,
			streaming: options.finalized ? false : (usage.streaming ?? current.streaming),
		};
		this.values.set(sessionId, Object.freeze(next));
	}
	reset(sessionId?: string): void {
		if (sessionId === undefined) {
			this.values.clear();
			this.events.clear();
			this.finalized.clear();
			return;
		}
		this.values.delete(sessionId);
		this.events.delete(sessionId);
		this.finalized.delete(sessionId);
	}
}

export class InMemoryContextProvider implements ContextProvider {
	private readonly values = new Map<string, ContextSnapshot>();
	get(sessionId: string): ContextSnapshot | undefined {
		return this.values.get(sessionId);
	}
	set(sessionId: string, context: ContextSnapshot): void {
		this.values.set(sessionId, Object.freeze({ ...context }));
	}
	clear(sessionId?: string): void {
		if (sessionId === undefined) this.values.clear();
		else this.values.delete(sessionId);
	}
}

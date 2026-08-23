import type { ContextSnapshot, GitSnapshot, StatusSnapshot, UsageSnapshot } from "./status.js";

export interface GitCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

export interface GitCommandRunner {
	run(args: readonly string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<GitCommandResult>;
}

export interface GitProvider {
	get(cwd: string): Promise<GitSnapshot>;
	invalidate(cwd?: string): void;
	dispose(): void;
}

export interface UsageProvider {
	get(sessionId: string): UsageSnapshot;
	record(sessionId: string, usage: Partial<UsageSnapshot>, options?: { eventId?: string; finalized?: boolean }): void;
	reset(sessionId?: string): void;
}

export interface ContextProvider {
	get(sessionId: string): ContextSnapshot | undefined;
	set(sessionId: string, context: ContextSnapshot): void;
	clear(sessionId?: string): void;
}

export interface StatusProviderBundle {
	readonly git: GitProvider;
	readonly usage: UsageProvider;
	readonly context: ContextProvider;
}

export type SnapshotStatusValues = Pick<StatusSnapshot, "model" | "thinkingLevel" | "git" | "context" | "usage">;

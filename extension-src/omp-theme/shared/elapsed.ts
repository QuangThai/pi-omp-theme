// Tool metrics: elapsed wall time formatting and lookup.

const ELAPSED_KEY = "__elapsedMs";

export interface MetricResultLike {
	readonly content?: readonly unknown[];
	readonly details?: unknown;
}

export function formatElapsedMs(ms: number | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export function getElapsedMs(result: MetricResultLike | undefined): number | undefined {
	if (!result || typeof result.details !== "object" || result.details === null) return undefined;
	const elapsed = (result.details as Record<string, unknown>)[ELAPSED_KEY];
	return typeof elapsed === "number" && Number.isFinite(elapsed) ? elapsed : undefined;
}

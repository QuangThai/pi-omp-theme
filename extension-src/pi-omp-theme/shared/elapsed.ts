// Tool metrics: elapsed wall time + output size formatting and annotation.

const ELAPSED_KEY = "__elapsedMs";
const OUTPUT_CHARS_KEY = "__outputChars";

export interface MetricResultLike {
	readonly content?: readonly unknown[];
	readonly details?: unknown;
}

function getTextOutputLength(result: MetricResultLike): number {
	if (!Array.isArray(result.content)) return 0;
	let length = 0;
	let seenText = false;
	for (const contentBlock of result.content) {
		if (!contentBlock || typeof contentBlock !== "object") continue;
		const block = contentBlock as { type?: unknown; text?: unknown };
		if (block.type !== "text") continue;
		if (seenText) length += 1; // matches getTextOutput() joining text blocks with newlines
		length += String(block.text ?? "").replace(/\r/g, "").length;
		seenText = true;
	}
	return length;
}

function formatCompactCount(value: number): string {
	if (value < 1000) return `${Math.round(value)}`;
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
	return `${Math.round(value / 1000000)}M`;
}

export function formatElapsedMs(ms: number | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export function formatOutputChars(chars: number | undefined): string {
	if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) return "";
	return `${formatCompactCount(chars)} ${chars === 1 ? "char" : "chars"}`;
}

export function formatToolMetricsFromValues(elapsedMs: number | undefined, outputChars: number | undefined): string {
	return [formatElapsedMs(elapsedMs), formatOutputChars(outputChars)].filter(Boolean).join(" · ");
}

export function getElapsedMs(result: MetricResultLike | undefined): number | undefined {
	if (!result || typeof result.details !== "object" || result.details === null) return undefined;
	const elapsed = (result.details as Record<string, unknown>)[ELAPSED_KEY];
	return typeof elapsed === "number" && Number.isFinite(elapsed) ? elapsed : undefined;
}

export function formatElapsed(result: MetricResultLike | undefined): string {
	return formatElapsedMs(getElapsedMs(result));
}

export function formatOutputSize(result: MetricResultLike | undefined): string {
	return formatOutputChars(
		(result?.details as Record<string, unknown> | undefined)?.[OUTPUT_CHARS_KEY] as number | undefined,
	);
}

export function formatToolMetrics(result: MetricResultLike | undefined): string {
	return [formatElapsed(result), formatOutputSize(result)].filter(Boolean).join(" · ");
}

/** Annotate elapsed/output metrics into a result's details (only when absent). */
export function annotateToolResultMetrics(result: MetricResultLike | undefined, elapsedMs?: number): void {
	if (!result || typeof result !== "object") return;
	if (!result.details || typeof result.details !== "object") {
		(result as { details?: unknown }).details = {};
	}
	const details = result.details as Record<string, unknown>;
	const existingElapsed = details[ELAPSED_KEY];
	if (
		typeof elapsedMs === "number" &&
		Number.isFinite(elapsedMs) &&
		(typeof existingElapsed !== "number" || !Number.isFinite(existingElapsed))
	) {
		details[ELAPSED_KEY] = elapsedMs;
	}
	if (typeof details[OUTPUT_CHARS_KEY] !== "number" || !Number.isFinite(details[OUTPUT_CHARS_KEY])) {
		details[OUTPUT_CHARS_KEY] = getTextOutputLength(result);
	}
}

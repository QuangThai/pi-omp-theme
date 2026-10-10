// Live thinking durations for the collapsed `● Thought for 6s` line.
//
// Pi streams `thinking_start` / `thinking_end` per content block through the
// extension's `message_update` events. Each block's wall-clock span is kept per
// message (keyed by the message timestamp, which a streamed message keeps once
// finalized) and per content index, so a message with several thinking runs
// reports each run's own time. Restored sessions carry no timing: their runs
// read `● Thought`.

interface BlockTiming {
	startedAt: number;
	endedAt?: number;
}

/** Messages remembered at once; older entries fall out first. */
const MAX_MESSAGES = 256;

const timings = new Map<number, Map<number, BlockTiming>>();

function messageKey(message: unknown): number | undefined {
	const timestamp = (message as { timestamp?: unknown } | undefined)?.timestamp;
	return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

/** Record a `message_update` event (only thinking start/end events matter). */
export function noteThinkingEvent(message: unknown, event: unknown, now: number = performance.now()): void {
	const { type, contentIndex } = (event ?? {}) as { type?: unknown; contentIndex?: unknown };
	if ((type !== "thinking_start" && type !== "thinking_end") || typeof contentIndex !== "number") return;
	const key = messageKey(message) ?? messageKey((event as { partial?: unknown }).partial);
	if (key === undefined) return;
	let blocks = timings.get(key);
	if (!blocks) {
		if (timings.size >= MAX_MESSAGES) {
			const oldest = timings.keys().next().value;
			if (oldest !== undefined) timings.delete(oldest);
		}
		blocks = new Map();
		timings.set(key, blocks);
	}
	if (type === "thinking_start") {
		if (!blocks.has(contentIndex)) blocks.set(contentIndex, { startedAt: now });
		return;
	}
	const block = blocks.get(contentIndex);
	if (block && block.endedAt === undefined) block.endedAt = now;
}

/**
 * Total thinking time of the given content blocks, or undefined unless every
 * block with a recorded start also has a recorded end.
 */
export function thinkingDurationMs(message: unknown, contentIndices: readonly number[]): number | undefined {
	const key = messageKey(message);
	const blocks = key === undefined ? undefined : timings.get(key);
	if (!blocks) return undefined;
	let total = 0;
	let seen = false;
	for (const index of contentIndices) {
		const block = blocks.get(index);
		if (!block) continue;
		if (block.endedAt === undefined) return undefined;
		total += Math.max(0, block.endedAt - block.startedAt);
		seen = true;
	}
	return seen ? total : undefined;
}

/** Forget every recorded duration (session start/shutdown). */
export function resetThinkingTimings(): void {
	timings.clear();
}

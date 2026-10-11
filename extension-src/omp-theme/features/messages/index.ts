// Width goes through the fast path in render-budget: Pi's own visibleWidth runs
// grapheme segmentation and emoji regexes per call, which dominates the per-frame
// cost on long messages. The fast path answers plain SGR + ASCII directly and
// falls back to Pi's for anything else, so the measure stays identical.
import { formatElapsedMs } from "../../shared/elapsed.js";
import { displayKeyHint } from "../../shared/keybinding-hints.js";
import { safeVisibleWidth as visibleWidth } from "../../shared/render-budget.js";
import { thinkingDurationMs } from "./thinking-timing.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
type OscParts = { start: string; body: string; end: string };

function extractOscEnvelope(line: string): OscParts | undefined {
	if (!line.startsWith(OSC133_ZONE_START)) return undefined;
	const bodyEnd = line.indexOf(OSC133_ZONE_END, OSC133_ZONE_START.length);
	if (bodyEnd < 0 || !line.endsWith(OSC133_ZONE_FINAL)) return undefined;
	return { start: OSC133_ZONE_START, body: line.slice(OSC133_ZONE_START.length, bodyEnd), end: line.slice(bodyEnd) };
}

const BG_RESET = "\x1b[49m";

/** Leading zero-width OSC sequences (e.g. OSC133 markers) of a line. */
function splitLeadingMarkers(line: string): { head: string; rest: string } {
	let index = 0;
	while (line.startsWith("\x1b]", index)) {
		const bel = line.indexOf("\x07", index + 2);
		const st = line.indexOf("\x1b\\", index + 2);
		const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
		if (end === -1) break;
		index = end + 1;
	}
	return { head: line.slice(0, index), rest: line.slice(index) };
}

/** Leading SGR escape sequence of a line ("" when none). */
function leadingSgr(line: string): string {
	if (!line.startsWith("\x1b[")) return "";
	let index = 2;
	while (index < line.length) {
		const code = line.charCodeAt(index);
		if (code >= 64 && code <= 126) return line.slice(0, index + 1);
		index++;
	}
	return "";
}

/** Whether an SGR sequence sets/resets the terminal background color. */
function isBackgroundSgr(sequence: string): boolean {
	if (!sequence.startsWith("\x1b[") || !sequence.endsWith("m")) return false;
	for (const code of sequence.slice(2, -1).split(";")) {
		const value = Number(code);
		if (value === 48 || value === 49) return true;
		if (value >= 40 && value <= 47) return true;
		if (value >= 100 && value <= 107) return true;
	}
	return false;
}

/**
 * Rebuild a native line so `lead` (prompt prefix / continuation indent) and the
 * full target width are covered by the line's background.
 *
 * Native Box lines (user messages) are `bgAnsi + body + \x1b[49m`; prepending the
 * prefix outside that wrap shifted the input row's background right by the
 * prefix width while keeping the full container width, producing a staircase
 * box (indented left, overflowing right). Rebuilding inside the wrap keeps the
 * background flush across every row; plain (unwrapped) lines are padded to the
 * target width instead so left/right edges stay aligned.
 */
function rebuildAtWidth(line: string, width: number, lead: string): string {
	const { head, rest } = splitLeadingMarkers(line);
	const bgAnsi = leadingSgr(rest);
	if (bgAnsi && isBackgroundSgr(bgAnsi) && rest.endsWith(BG_RESET)) {
		const body = rest.slice(bgAnsi.length, rest.length - BG_RESET.length);
		const pad = " ".repeat(Math.max(0, width - visibleWidth(lead) - visibleWidth(body)));
		return `${head}${bgAnsi}${lead}${body}${pad}${BG_RESET}`;
	}
	const padded = `${lead}${line}`;
	return `${padded}${" ".repeat(Math.max(0, width - visibleWidth(padded)))}`;
}

function decorateMessageLine(
	line: string,
	index: number,
	lastIndex: number,
	contentIndex: number,
	width: number,
	options: {
		firstEnvelope: OscParts | undefined;
		firstHasStart: boolean;
		multilineEnvelope: boolean;
		prefix: string;
	},
): string {
	const { firstEnvelope, firstHasStart, multilineEnvelope, prefix } = options;
	const prefixWidth = visibleWidth(prefix);
	const lead = index === contentIndex ? prefix : index > contentIndex ? " ".repeat(prefixWidth) : "";
	if (index === contentIndex && firstEnvelope)
		return `${firstEnvelope.start}${rebuildAtWidth(firstEnvelope.body, width, prefix)}${firstEnvelope.end}`;
	if (index === contentIndex && firstHasStart)
		return `${OSC133_ZONE_START}${rebuildAtWidth(line.slice(OSC133_ZONE_START.length), width, prefix)}`;
	if (index === lastIndex && multilineEnvelope && index !== contentIndex)
		return `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${rebuildAtWidth(
			line.slice((OSC133_ZONE_END + OSC133_ZONE_FINAL).length),
			width,
			lead,
		)}`;
	if (
		index === contentIndex &&
		index === lastIndex &&
		multilineEnvelope &&
		line.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)
	)
		return `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${rebuildAtWidth(
			line.slice((OSC133_ZONE_END + OSC133_ZONE_FINAL).length),
			width,
			prefix,
		)}`;
	return rebuildAtWidth(line, width, lead);
}

function contentText(line: string): string {
	let output = "";
	for (let index = 0; index < line.length; index++) {
		if (line.charCodeAt(index) !== 27) {
			output += line[index];
			continue;
		}
		const next = line[index + 1];
		if (next === "]") {
			index += 2;
			while (index < line.length && line.charCodeAt(index) !== 7) index++;
			continue;
		}
		if (next === "[") {
			index += 2;
			while (index < line.length && (line.charCodeAt(index) < 64 || line.charCodeAt(index) > 126)) index++;
		}
	}
	return output.replaceAll(OSC133_ZONE_START, "").replaceAll(OSC133_ZONE_END, "").replaceAll(OSC133_ZONE_FINAL, "");
}

function hasContent(line: string): boolean {
	return [...contentText(line)].some((character) => !/\s/u.test(character));
}

function prefixNative(lines: unknown, width: number, prefix: string): string[] | undefined {
	if (!Array.isArray(lines) || lines.length === 0 || !lines.every((line) => typeof line === "string")) return undefined;
	const nativeLines = lines as string[];
	const prefixWidth = visibleWidth(prefix);
	if (width <= prefixWidth) return undefined;
	const bodyWidth = width - prefixWidth;
	const first = nativeLines[0] ?? "";
	const last = nativeLines.at(-1) ?? "";
	const multilineEnvelope = nativeLines.length > 1 && last.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL);
	// The last line is a content-start candidate only when the envelope is
	// single-line, or when no earlier line carries content. Assistant messages
	// with a single content line render as a multiline envelope whose only body
	// sits on the final line ([OSC133_A, OSC133_END+FINAL+body]); excluding it
	// would drop the prefix for every short assistant reply.
	const firstContentIndex = nativeLines.findIndex((line, index) => {
		if (index !== nativeLines.length - 1 || !multilineEnvelope) return hasContent(line);
		return !nativeLines.slice(0, index).some((earlier) => hasContent(earlier)) && hasContent(line);
	});
	if (firstContentIndex < 0) return nativeLines;
	const firstEnvelope = firstContentIndex === 0 ? extractOscEnvelope(first) : undefined;
	const firstHasStart = firstContentIndex === 0 && first.startsWith(OSC133_ZONE_START);
	const decorated = nativeLines.map((line, index) =>
		decorateMessageLine(line, index, nativeLines.length - 1, firstContentIndex, width, {
			firstEnvelope,
			firstHasStart,
			multilineEnvelope,
			prefix,
		}),
	);
	if (!decorated.every((line) => visibleWidth(line) <= width)) return undefined;
	if (!nativeLines.every((line) => visibleWidth(line) <= bodyWidth)) return undefined;
	return decorated;
}

export type MessageDecorationSnapshot = Readonly<{
	assistantPrefix: string;
	assistantEnabled: boolean;
	/** Drop the hidden-thinking label row and its trailing spacer (zero-trace collapse). */
	collapseHiddenThinking: boolean;
	/** Hide the text of assistant messages that also carry tool calls (interim narration). */
	hideInterimText: boolean;
	/** Mark each assistant text block with the assistant marker, lines hanging under it. */
	assistantMarker?: boolean;
	/** Replace the hidden-thinking label with `● Thinking…` / `● Thought for 6s`. */
	thinkingSummary?: boolean;
	/** Follow Pi's interrupted-turn notice with `· What should the agent do instead?`. */
	interruptHint?: boolean;
}>;

export function decorateMessageRender(
	original: unknown,
	instance: object,
	args: unknown[],
	snapshot: MessageDecorationSnapshot = {
		assistantPrefix: "│ ",
		assistantEnabled: true,
		collapseHiddenThinking: false,
		hideInterimText: false,
	},
): unknown {
	if (typeof original !== "function") return undefined;
	const width = typeof args[0] === "number" ? args[0] : 0;
	const prefix = snapshot.assistantPrefix;
	if (!snapshot.assistantEnabled) return Reflect.apply(original, instance, args);
	if (width <= visibleWidth(prefix)) return Reflect.apply(original, instance, args);
	// Exactly one native invocation. If the reduced render cannot be certified, the
	// already-obtained result is the only safe fallback; retrying can mutate state.
	const reducedWidth = width - visibleWidth(prefix);
	const native = Reflect.apply(original, instance, [reducedWidth, ...args.slice(1)]);
	return prefixNative(native, width, prefix) ?? native;
}

/** Spacer-like: renders empty lines and exposes only setLines among these surfaces. */
function isSpacerChild(child: unknown): boolean {
	return typeof (child as { setLines?: unknown } | undefined)?.setLines === "function";
}

/**
 * The assistant TEXT Markdown block: `Markdown(text, pad, 0, theme, undefined,
 * { transform })` — duck-typed by setText + options object + no defaultTextStyle.
 * Thinking Markdown passes a `{ color, italic }` defaultTextStyle and is
 * therefore excluded; plain Text components carry no `options`.
 */
function isInterimTextChild(child: unknown): boolean {
	const candidate = child as { setText?: unknown; options?: unknown; defaultTextStyle?: unknown } | undefined;
	return (
		typeof candidate?.setText === "function" &&
		candidate.options !== undefined &&
		typeof candidate.options === "object" &&
		candidate.defaultTextStyle === undefined
	);
}

/** Whether the message content includes a toolCall item (interim narration marker). */
function hasToolCallItems(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const content = (message as { content?: unknown }).content;
	return (
		Array.isArray(content) &&
		content.some(
			(item) => item !== null && typeof item === "object" && (item as { type?: unknown }).type === "toolCall",
		)
	);
}

/**
 * Pi 0.85 wraps thinking blocks in `MouseRegion` for click-to-toggle. Unwrap
 * those presentation-only containers without importing pi-tui, because
 * pi-coding-agent may resolve a nested copy and `instanceof` is unreliable.
 */
function unwrapPresentationChild(child: unknown): unknown {
	let current = child;
	for (let depth = 0; depth < 4; depth++) {
		if (!current || typeof current !== "object") break;
		const nested = (current as { child?: unknown }).child;
		if (nested === undefined || nested === current) break;
		current = nested;
	}
	return current;
}

/**
 * The hidden-thinking placeholder: a Text (setCustomBgFn) whose ANSI-stripped
 * rendered content is empty. Duck-typed on the public shape because
 * pi-coding-agent may resolve its own nested pi-tui copy, so `instanceof`
 * across that module boundary is unreliable.
 */
function isBlankTextChild(child: unknown): boolean {
	const candidate = unwrapPresentationChild(child) as
		| { setCustomBgFn?: unknown; render?: (width: number) => string[] }
		| undefined;
	if (typeof candidate?.setCustomBgFn !== "function" || typeof candidate.render !== "function") return false;
	return contentText(candidate.render(0).join("\n")).trim() === "";
}

/**
 * Collapse Pi's hidden-thinking placeholder row to zero trace.
 *
 * Native `AssistantMessageComponent.updateContent` renders the thinking block as
 * `Text(theme.italic(theme.fg("thinkingText", label)), outputPad, 0)` plus a
 * trailing `Spacer(1)`. An empty label is still wrapped in ANSI SGR codes, so
 * `Text.render` cannot treat it as empty (its check is `text.trim() === ""`,
 * and trim does not strip escape sequences) and emits one full-width invisible
 * line. That invisible row plus the surrounding spacers is the "gap" left when
 * the label is hidden. This wrapper runs the native layout, then drops the
 * invisible label row and the spacer the native layout appends after the
 * thinking run, leaving the same single top padding as a text-only message.
 */
export function decorateMessageUpdate(
	original: unknown,
	instance: object,
	args: unknown[],
	snapshot: MessageDecorationSnapshot = {
		assistantPrefix: "│ ",
		assistantEnabled: true,
		collapseHiddenThinking: false,
		hideInterimText: false,
	},
): unknown {
	if (typeof original !== "function") return undefined;
	const result = Reflect.apply(original, instance, args);
	const target = instance as {
		hideThinkingBlock?: boolean;
		hiddenThinkingLabel?: string;
		contentContainer?: { children?: unknown[] };
	};
	// Only meaningful when Pi renders the hidden-block label (hideThinkingBlock)
	// and the extension has blanked that label out ("" — the zero-trace mode).
	if (snapshot.collapseHiddenThinking && target.hideThinkingBlock === true && target.hiddenThinkingLabel === "") {
		const children = target.contentContainer?.children;
		if (children) {
			for (let index = children.length - 1; index >= 0; index--) {
				if (!isBlankTextChild(children[index])) continue;
				children.splice(index, 1);
				// Drop the Spacer(1) the native layout appends after the thinking run when
				// another visible block follows; the message keeps only its shared top padding.
				if (isSpacerChild(children[index])) children.splice(index, 1);
			}
		}
	}
	// Interim narration: assistant messages that carry tool calls use their text
	// only to narrate while working; the tool blocks tell the story. Hide the text
	// so the feed shows the run's summary and the final answer. Deterministic per
	// content — streaming, scroll-back, and resume behave identically. Errors and
	// truncation notices are Text children and stay; if only spacers remain the
	// message becomes zero-trace.
	if (snapshot.hideInterimText && hasToolCallItems(args[0])) {
		const children = target.contentContainer?.children;
		if (children) {
			for (let index = children.length - 1; index >= 0; index--) {
				if (isInterimTextChild(children[index])) children.splice(index, 1);
			}
			if (children.every((child) => isSpacerChild(child))) children.length = 0;
		}
	}
	const children = target.contentContainer?.children;
	if (children && snapshot.thinkingSummary) decorateThinkingRuns(children, target, args[0]);
	if (children && snapshot.assistantMarker) {
		for (let index = 0; index < children.length; index++) {
			if (isInterimTextChild(children[index]))
				children[index] = markedChild(children[index] as MarkableChild, messageStyle.assistantMarker);
		}
	}
	if (children && snapshot.interruptHint) appendInterruptHint(children, args[0]);
	return result;
}

/** What Claude Code asks after an interrupted turn, worded for any agent. */
export const INTERRUPT_HINT = "What should the agent do instead?";

/** Node's AbortError message for a signal aborted without a reason, as Pi aborts a run. */
const ABORT_ERROR = "This operation was aborted";

/**
 * The notice row Pi closes an interrupted turn with, worded as Pi words it:
 * `Operation aborted` (or `Aborted after 2 retry attempts`) for an aborted
 * answer. An interruption during a tool run reads `Error: This operation was
 * aborted`: Pi starts the next request on the aborted signal, its setup throws
 * Node's AbortError, and Pi records that as an error message with no content.
 * A turn that ended on tool calls carries no notice (Pi shows the abort on the
 * tool blocks).
 */
function interruptNotice(message: unknown): string | undefined {
	const { stopReason, errorMessage, content } = (message ?? {}) as {
		stopReason?: unknown;
		errorMessage?: unknown;
		content?: unknown;
	};
	if (hasToolCallItems(message)) return undefined;
	if (stopReason === "aborted")
		return typeof errorMessage === "string" && errorMessage && errorMessage !== "Request was aborted"
			? errorMessage
			: "Operation aborted";
	const empty = !Array.isArray(content) || !(content as MessageContent[]).some(isVisibleContent);
	if (stopReason === "error" && errorMessage === ABORT_ERROR && empty) return `Error: ${ABORT_ERROR}`;
	return undefined;
}

/**
 * Only Pi's notice row, the message's last block, gains the hint; it keeps
 * Pi's text and colour.
 */
function appendInterruptHint(children: unknown[], message: unknown): void {
	const notice = interruptNotice(message);
	if (!notice) return;
	const row = children.at(-1) as { text?: unknown; setText?: (text: string) => void; options?: unknown } | undefined;
	if (typeof row?.text !== "string" || typeof row.setText !== "function" || row.options !== undefined) return;
	if (contentText(row.text).trim() !== notice) return;
	const hint = ` · ${INTERRUPT_HINT}`;
	row.setText(`${row.text}${messageStyle.theme ? messageStyle.theme.fg("dim", hint) : hint}`);
}

// ── Inline message style (Claude Code transcript) ────────────────────────────

interface MessageTheme {
	fg(color: string, text: string): string;
}

interface MessageStyle {
	theme: MessageTheme | undefined;
	/** Leading marker of an assistant text block (`●`). */
	assistantMarker: string;
	/** Leading marker of a thinking run (`●`, accent-coloured). */
	thinkingMarker: string;
}

let messageStyle: MessageStyle = { theme: undefined, assistantMarker: "●", thinkingMarker: "●" };

/** Set by the session coordinator: the session theme and resolved glyphs. */
export function setMessageDecorationStyle(style: Partial<MessageStyle>): void {
	messageStyle = { ...messageStyle, ...style };
}

/** The hidden-thinking label the session hands Pi while summaries are on. */
export const THINKING_SUMMARY_LABEL = "● Thinking…";

type MarkableChild = {
	render(width: number): string[];
	invalidate?(): void;
	handleMouse?(event: unknown): unknown;
};

/**
 * A block with a marker in the first column and every line hanging after it.
 * Mouse events pass straight through, so a thinking run still toggles on click.
 */
function markedChild(child: MarkableChild, marker: string): MarkableChild {
	const markerWidth = Math.max(1, visibleWidth(marker));
	const hang = " ".repeat(markerWidth);
	return {
		render(width: number): string[] {
			if (width <= markerWidth + 1) return child.render(width);
			const lines = child.render(width - markerWidth);
			// Pi pads its blocks one column from the edge; the marker takes that slot's
			// neighbour, so content keeps the column it had.
			return lines.map((line, index) => `${index === 0 ? marker : hang}${line}`);
		},
		invalidate() {
			child.invalidate?.();
		},
		handleMouse(event: unknown) {
			return child.handleMouse?.(event);
		},
	};
}

/** Pi wraps each thinking run (hidden label or visible text) in a click region. */
function isThinkingRegion(child: unknown): boolean {
	const candidate = child as { child?: unknown; onMouse?: unknown } | undefined;
	return typeof candidate?.onMouse === "function" && candidate.child !== undefined;
}

type MessageContent = { type?: unknown; text?: unknown; thinking?: unknown };

function isVisibleContent(item: MessageContent): boolean {
	if (item.type === "text") return typeof item.text === "string" && item.text.trim() !== "";
	if (item.type === "thinking") return typeof item.thinking === "string" && item.thinking.trim() !== "";
	return item.type === "toolCall";
}

/** Thinking runs as Pi renders them: consecutive blocks with any non-blank text. */
function thinkingRuns(content: readonly MessageContent[]): Array<{ indices: number[]; last: number }> {
	const runs: Array<{ indices: number[]; last: number }> = [];
	for (let index = 0; index < content.length; index++) {
		if (content[index]?.type !== "thinking") continue;
		const indices: number[] = [];
		while (index < content.length && content[index]?.type === "thinking") indices.push(index++);
		index--;
		if (indices.some((at) => isVisibleContent(content[at] ?? {}))) runs.push({ indices, last: indices.at(-1) ?? 0 });
	}
	return runs;
}

function thinkingSummaryText(message: unknown, run: { indices: number[]; last: number }, streaming: boolean): string {
	const content = ((message as { content?: unknown })?.content ?? []) as MessageContent[];
	const inProgress = streaming && !content.slice(run.last + 1).some(isVisibleContent);
	if (inProgress) return "Thinking…";
	const duration = thinkingDurationMs(message, run.indices);
	const label = duration === undefined ? "Thought" : `Thought for ${formatElapsedMs(duration)}`;
	const hint = displayKeyHint("app.thinking.toggle", "to show");
	return hint ? `${label} · ${hint}` : label;
}

/**
 * Collapsed thinking reads `● Thought for 6s · Ctrl+T to show`; shown thinking
 * keeps its text with the same marker. Pi's own label (the session sets
 * THINKING_SUMMARY_LABEL) is rewritten in place, so its styling, click toggle
 * and spacing stay native.
 */
function decorateThinkingRuns(children: unknown[], target: { hiddenThinkingLabel?: string; isStreaming?: boolean }, message: unknown): void {
	const content = ((message as { content?: unknown })?.content ?? []) as MessageContent[];
	if (!Array.isArray(content)) return;
	const runs = thinkingRuns(content);
	const label = target.hiddenThinkingLabel ?? "";
	const theme = messageStyle.theme;
	// The same dot as answers and tools, told apart by colour: a three-dot ∴ at
	// thinkingText weight all but disappears in common terminal fonts.
	const marker = theme ? theme.fg("accent", messageStyle.thinkingMarker) : messageStyle.thinkingMarker;
	let runIndex = 0;
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		if (!isThinkingRegion(child)) continue;
		const run = runs[runIndex++];
		const inner = unwrapPresentationChild(child) as { text?: unknown; setText?: (text: string) => void };
		if (run && label && typeof inner?.text === "string" && typeof inner.setText === "function") {
			if (contentText(inner.text).trim() === label.trim()) {
				inner.setText(inner.text.replace(label, thinkingSummaryText(message, run, target.isStreaming === true)));
			}
		}
		children[index] = markedChild(child as MarkableChild, marker);
	}
}

// Special private layouts are intentionally not installed; their prototypes remain native.

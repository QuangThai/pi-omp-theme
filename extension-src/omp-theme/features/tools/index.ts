// Width goes through the fast path in render-budget: Pi's own visibleWidth runs
// grapheme segmentation and emoji regexes per call, which dominates the per-frame
// cost on long messages. The fast path answers plain SGR + ASCII directly and
// falls back to Pi's for anything else, so the measure stays identical.
import { safeVisibleWidth as visibleWidth } from "../../shared/render-budget.js";
import { EMPTY_BATCH_COMPONENT } from "./boxed/batch.js";
import { renderBoxedToolCall, renderBoxedToolResult } from "./boxed/index.js";
import { clearPresentationTui, notePresentationTui } from "./boxed/render-viewport.js";

/**
 * Batch members render zero lines. Pi's ToolExecutionComponent always adds a
 * built-in Spacer child (one blank line) and only sets hideComponent when
 * hasContent is false — but adding an empty renderer still marks hasContent
 * true. Mark the instance hidden so members contribute zero lines (no stray
 * blank margin after the batch panel). updateDisplay resets hideComponent on
 * every pass; the wrapper re-applies it on each dispatch.
 */
function hideBatchMember(instance: object): void {
	(instance as { hideComponent?: boolean }).hideComponent = true;
}

/**
 * Neutralize the native ToolExecutionComponent status background for boxed
 * rendering: Pi's updateDisplay sets contentBox/selfRenderContainer bgFn to
 * toolPendingBg/toolErrorBg/toolSuccessBg before invoking the renderers. The
 * boxed renderers own their visual boundary (borders + ✓/✘ state marks), so the
 * container fill is removed (no background slab).
 * Runs on every boxed dispatch; updateDisplay re-applies the bgFn on the next
 * pass and this wrapper re-neutralizes it.
 */
function neutralizeToolContainerBackground(instance: object): void {
	const host = instance as {
		getRenderShell?(): string;
		selfRenderContainer?: { setBgFn?(fn: (text: string) => string): void; paddingX?: number; paddingY?: number };
		contentBox?: { setBgFn?(fn: (text: string) => string): void; paddingX?: number; paddingY?: number };
	};
	const container =
		typeof host.getRenderShell === "function" && host.getRenderShell() === "self"
			? host.selfRenderContainer
			: host.contentBox;
	if (!container) return;
	container.paddingX = 0;
	container.paddingY = 0;
	if (typeof container.setBgFn === "function") container.setBgFn((text) => text);
}

type RenderFunction = (this: object, ...args: unknown[]) => unknown;
type RendererSubtype = "tool-call-renderer" | "tool-result-renderer";
type RendererKind = "call" | "result";
type TransactionState = "never-written" | "installed-owned" | "owner-changed" | "rollback-restored" | "rollback-failed";
type ToolRenderContext = {
	args: object;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: object | undefined;
	state: object;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
};
type ToolDecorationSnapshot = Readonly<{
	callMarker: string;
	resultMarker: string;
	/** marker = prefix lines; compact-box = boxed tool call/result rendering. */
	style?: "marker" | "compact-box";
}>;
type DescriptorView = Readonly<{
	kind: "data" | "accessor";
	value?: unknown;
	get?: unknown;
	set?: unknown;
	writable?: boolean;
	enumerable: boolean;
	configurable: boolean;
}>;
type FailureEntry = Readonly<{ reason: string; transaction: TransactionState }>;
export type ToolDiagnosticArchive = Readonly<{
	owner: string;
	generation: number;
	reasons: Readonly<Record<string, number>>;
	restored: number;
	failed: number;
	laterOwner: number;
	failures: readonly FailureEntry[];
}>;
type CleanupOutcome = "restored" | "later-owner" | "retry";
type DecorationRecord = {
	component: object;
	nativeRender: RenderFunction;
	wrappedRender: RenderFunction;
	attemptedDescriptor: PropertyDescriptor;
	originalOwnDescriptor?: PropertyDescriptor;
	inheritedDescriptor?: PropertyDescriptor;
	context: ToolRenderContext;
	transaction: TransactionState;
	lastFailureSignature?: string;
};
type DecorationState = {
	snapshot: ToolDecorationSnapshot;
	decorated: WeakMap<object, DecorationRecord>;
	active: Set<DecorationRecord>;
	diagnostics: Map<string, number>;
	failures: FailureEntry[];
	archive?: ToolDiagnosticArchive;
	restored: number;
	failed: number;
	laterOwner: number;
	generation: number;
};
const DEFAULT_SNAPSHOT: ToolDecorationSnapshot = Object.freeze({
	callMarker: "[tool] ",
	resultMarker: "[tool:result] ",
	style: "marker",
});
let ownerGeneration = 0;
const piOmpThemeWrappers = new WeakSet<RenderFunction>();

/**
 * The real Tui instance captured from decorated tool components (`instance.ui`),
 * used to request a repaint after the turn registry flips a turn to collapsed
 * (pi only re-paints after its own events; the renderer selectors re-run on
 * updateDisplay, but the screen refresh still needs a requestRender).
 */
let capturedToolUi: { requestRender?: (force?: boolean) => void } | undefined;

/** Request a screen repaint through the captured tool Tui (no-op headless). */
export function requestToolPresentationRender(): void {
	capturedToolUi?.requestRender?.();
}
let toolTestHooks: { defineProperty?: typeof Reflect.defineProperty; deleteProperty?: typeof Reflect.deleteProperty } =
	{};
export function __setToolDecorationTestHooks(hooks: typeof toolTestHooks): () => void {
	const previous = toolTestHooks;
	toolTestHooks = hooks;
	return () => {
		toolTestHooks = previous;
	};
}

function note(state: DecorationState, reason: string, transaction: TransactionState = "never-written"): void {
	state.diagnostics.set(reason, (state.diagnostics.get(reason) ?? 0) + 1);
	if (state.failures.length < 32) state.failures.push(Object.freeze({ reason, transaction }));
}
function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}
function ownData(object: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function hasOwnData(object: object, key: string): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor !== undefined && "value" in descriptor;
}
function validContext(value: unknown): value is ToolRenderContext {
	if (!isObject(value)) return false;
	const booleans = ["isPartial", "expanded", "isError", "executionStarted", "argsComplete", "showImages"] as const;
	return (
		isObject(ownData(value, "args")) &&
		typeof ownData(value, "toolCallId") === "string" &&
		typeof ownData(value, "invalidate") === "function" &&
		isObject(ownData(value, "state")) &&
		typeof ownData(value, "cwd") === "string" &&
		booleans.every((key) => typeof ownData(value, key) === "boolean") &&
		hasOwnData(value, "lastComponent") &&
		(ownData(value, "lastComponent") === undefined || isObject(ownData(value, "lastComponent")))
	);
}
function validCallArgs(args: unknown[]): args is [object, object, ToolRenderContext] {
	return args.length === 3 && isObject(args[0]) && isObject(args[1]) && validContext(args[2]);
}
function validResultArgs(args: unknown[]): args is [object, object, object, ToolRenderContext] {
	const [result, options, theme, context] = args;
	return (
		isObject(result) &&
		hasOwnData(result, "content") &&
		Array.isArray(ownData(result, "content")) &&
		hasOwnData(result, "details") &&
		isObject(options) &&
		typeof ownData(options, "expanded") === "boolean" &&
		typeof ownData(options, "isPartial") === "boolean" &&
		isObject(theme) &&
		validContext(context)
	);
}
function normalizeToolRenderContext(instance: object, value: unknown, args: object): ToolRenderContext {
	if (validContext(value)) return value;
	const context = isObject(value) ? value : {};
	const hostState = ownData(instance, "rendererState");
	const state = isObject(ownData(context, "state"))
		? (ownData(context, "state") as object)
		: isObject(hostState)
			? hostState
			: {};
	const hostInvalidate = (instance as { invalidate?: unknown }).invalidate;
	const candidateInvalidate = ownData(context, "invalidate");
	const lastComponent = ownData(context, "lastComponent");
	const result = ownData(instance, "result");
	const boolean = (key: string, fallback = false): boolean => {
		const candidate = ownData(context, key);
		if (typeof candidate === "boolean") return candidate;
		const host = ownData(instance, key);
		return typeof host === "boolean" ? host : fallback;
	};
	return {
		args,
		toolCallId:
			typeof ownData(context, "toolCallId") === "string"
				? (ownData(context, "toolCallId") as string)
				: typeof ownData(instance, "toolCallId") === "string"
					? (ownData(instance, "toolCallId") as string)
					: "unknown-tool-call",
		invalidate:
			typeof candidateInvalidate === "function"
				? (candidateInvalidate as () => void)
				: typeof hostInvalidate === "function"
					? () => Reflect.apply(hostInvalidate as (...values: unknown[]) => unknown, instance, [])
					: () => {},
		lastComponent: lastComponent === undefined || isObject(lastComponent) ? lastComponent : undefined,
		state,
		cwd:
			typeof ownData(context, "cwd") === "string"
				? (ownData(context, "cwd") as string)
				: typeof ownData(instance, "cwd") === "string"
					? (ownData(instance, "cwd") as string)
					: process.cwd(),
		executionStarted: boolean("executionStarted"),
		argsComplete: boolean("argsComplete"),
		isPartial: boolean("isPartial", true),
		expanded: boolean("expanded"),
		showImages: boolean("showImages"),
		isError: boolean("isError", isObject(result) && ownData(result, "isError") === true),
	};
}
function descriptorView(descriptor: PropertyDescriptor | undefined): DescriptorView | undefined {
	if (!descriptor) return undefined;
	if ("value" in descriptor)
		return Object.freeze({
			kind: "data",
			value: descriptor.value,
			writable: descriptor.writable === true,
			enumerable: descriptor.enumerable === true,
			configurable: descriptor.configurable === true,
		});
	return Object.freeze({
		kind: "accessor",
		get: descriptor.get,
		set: descriptor.set,
		enumerable: descriptor.enumerable === true,
		configurable: descriptor.configurable === true,
	});
}
function descriptorEqual(actual: PropertyDescriptor | undefined, expected: PropertyDescriptor | undefined): boolean {
	const a = descriptorView(actual),
		e = descriptorView(expected);
	return (
		a?.kind === e?.kind &&
		a?.value === e?.value &&
		a?.get === e?.get &&
		a?.set === e?.set &&
		a?.writable === e?.writable &&
		a?.enumerable === e?.enumerable &&
		a?.configurable === e?.configurable
	);
}
function renderDescriptor(
	component: object,
): { own?: PropertyDescriptor; inherited?: PropertyDescriptor; native?: RenderFunction } | false {
	const own = Object.getOwnPropertyDescriptor(component, "render");
	if (own && !("value" in own && typeof own.value === "function" && own.writable === true && own.configurable === true))
		return false;
	let cursor = Object.getPrototypeOf(component);
	let inherited: PropertyDescriptor | undefined;
	while (cursor && !inherited) {
		const descriptor = Object.getOwnPropertyDescriptor(cursor, "render");
		if (descriptor) inherited = descriptor;
		cursor = Object.getPrototypeOf(cursor);
	}
	if (!own && inherited && !("value" in inherited && typeof inherited.value === "function")) return false;
	const native = own?.value ?? (inherited && "value" in inherited ? inherited.value : undefined);
	return typeof native === "function"
		? { ...(own ? { own } : {}), ...(inherited ? { inherited } : {}), native }
		: false;
}
function marker(state: DecorationState, context: ToolRenderContext, kind: RendererKind): string {
	if (context.isError) return "[tool:error] ";
	if (context.isPartial) return context.executionStarted ? "[tool:running] " : "[tool:pending] ";
	return kind === "call" ? state.snapshot.callMarker : state.snapshot.resultMarker;
}
function decorateLines(state: DecorationState, value: unknown, width: unknown, prefix: string): unknown {
	if (!Array.isArray(value) || !value.every((line) => typeof line === "string")) {
		note(state, "malformed-render");
		return value;
	}
	if (typeof width !== "number" || !Number.isFinite(width) || width < 0) {
		note(state, "invalid-width");
		return value;
	}
	const lines = value as string[],
		prefixWidth = visibleWidth(prefix),
		bodyWidth = width - prefixWidth;
	if (width <= prefixWidth || !lines.every((line) => visibleWidth(line) <= bodyWidth)) {
		note(state, "reduced-native-fallback");
		return value;
	}
	const output =
		lines.length === 0 ? [prefix.trimEnd()] : lines.map((line, index) => (index === 0 ? `${prefix}${line}` : line));
	if (output.every((line) => visibleWidth(line) <= width)) return output;
	note(state, "overwide-decoration");
	return value;
}
function createRecord(
	state: DecorationState,
	component: object,
	nativeRender: RenderFunction,
	context: ToolRenderContext,
	kind: RendererKind,
	descriptors: { own?: PropertyDescriptor; inherited?: PropertyDescriptor },
): DecorationRecord {
	const attemptedDescriptor = descriptors.own
		? { ...descriptors.own, value: undefined as unknown as RenderFunction }
		: { value: undefined as unknown as RenderFunction, writable: true, enumerable: false, configurable: true };
	const record = {
		component,
		nativeRender,
		wrappedRender: undefined as unknown as RenderFunction,
		attemptedDescriptor,
		...(descriptors.own ? { originalOwnDescriptor: descriptors.own } : {}),
		...(descriptors.inherited ? { inheritedDescriptor: descriptors.inherited } : {}),
		context,
		transaction: "never-written" as TransactionState,
	};
	record.wrappedRender = function (this: object, ...renderArgs: unknown[]): unknown {
		const width = renderArgs[0],
			prefix = marker(state, record.context, kind);
		const nativeArgs =
			typeof width === "number" && width > visibleWidth(prefix)
				? [width - visibleWidth(prefix), ...renderArgs.slice(1)]
				: renderArgs;
		return decorateLines(state, Reflect.apply(record.nativeRender, this, nativeArgs), width, prefix);
	};
	piOmpThemeWrappers.add(record.wrappedRender);
	return record;
}
function installDecoration(state: DecorationState, record: DecorationRecord): void {
	record.attemptedDescriptor.value = record.wrappedRender;
	let wrote = false;
	try {
		wrote = Reflect.defineProperty(record.component, "render", record.attemptedDescriptor);
	} catch (error) {
		note(state, `render-install-threw: ${error instanceof Error ? error.message : String(error)}`, "never-written");
		return;
	}
	if (!wrote) {
		note(state, "render-install-rejected", "never-written");
		return;
	}
	const current = Object.getOwnPropertyDescriptor(record.component, "render");
	if (!descriptorEqual(current, record.attemptedDescriptor)) {
		if (current?.value === record.wrappedRender) {
			const restored = record.originalOwnDescriptor
				? (toolTestHooks.defineProperty ?? Reflect.defineProperty)(
						record.component,
						"render",
						record.originalOwnDescriptor,
					)
				: (toolTestHooks.deleteProperty ?? Reflect.deleteProperty)(record.component, "render");
			const after = Object.getOwnPropertyDescriptor(record.component, "render");
			if (
				restored &&
				(record.originalOwnDescriptor ? descriptorEqual(after, record.originalOwnDescriptor) : after === undefined)
			) {
				record.transaction = "rollback-restored";
				note(state, "render-install-flags-mismatch-rolled-back", record.transaction);
				return;
			}
			record.transaction = "rollback-failed";
			state.decorated.set(record.component, record);
			state.active.add(record);
			note(state, "render-install-rollback-failed", record.transaction);
			return;
		}
		record.transaction = "owner-changed";
		note(state, "render-owner-changed-during-install", record.transaction);
		return;
	}
	record.transaction = "installed-owned";
	state.decorated.set(record.component, record);
	state.active.add(record);
}
function restoreDecoration(state: DecorationState, record: DecorationRecord): CleanupOutcome {
	const current = Object.getOwnPropertyDescriptor(record.component, "render");
	if (!descriptorEqual(current, record.attemptedDescriptor)) {
		record.transaction = "owner-changed";
		state.laterOwner++;
		note(state, "render-owner-changed", record.transaction);
		return "later-owner";
	}
	const restored = record.originalOwnDescriptor
		? (toolTestHooks.defineProperty ?? Reflect.defineProperty)(record.component, "render", record.originalOwnDescriptor)
		: (toolTestHooks.deleteProperty ?? Reflect.deleteProperty)(record.component, "render");
	const after = Object.getOwnPropertyDescriptor(record.component, "render");
	const ok = record.originalOwnDescriptor ? descriptorEqual(after, record.originalOwnDescriptor) : after === undefined;
	if (!restored || !ok) {
		record.transaction = "rollback-failed";
		const signature = JSON.stringify(descriptorView(after));
		if (record.lastFailureSignature !== signature) {
			record.lastFailureSignature = signature;
			note(state, "render-restore-failed", record.transaction);
		}
		return "retry";
	}
	record.transaction = "rollback-restored";
	return "restored";
}
function finalize(state: DecorationState): ToolDiagnosticArchive {
	if (state.archive) return state.archive;
	const reasons = Object.freeze(Object.fromEntries(state.diagnostics));
	state.archive = Object.freeze({
		owner: `tool-owner-${state.generation}`,
		generation: state.generation,
		reasons,
		restored: state.restored,
		failed: state.failed,
		laterOwner: state.laterOwner,
		failures: Object.freeze(state.failures.slice(0, 32)),
	});
	return state.archive;
}
export function createToolDecorationOwner(snapshot: Partial<ToolDecorationSnapshot> = {}) {
	const state: DecorationState = {
		snapshot: Object.freeze({ ...DEFAULT_SNAPSHOT, ...snapshot }),
		decorated: new WeakMap(),
		active: new Set(),
		diagnostics: new Map(),
		failures: [],
		restored: 0,
		failed: 0,
		laterOwner: 0,
		generation: ++ownerGeneration,
	};
	const dispose = () => {
		if (state.archive)
			return {
				restored: state.restored,
				failed: state.failed,
				diagnostics: new Map(state.diagnostics),
				archive: state.archive,
			};
		for (const record of [...state.active]) {
			const outcome = restoreDecoration(state, record);
			if (outcome === "restored") {
				state.restored++;
				state.active.delete(record);
			} else if (outcome === "later-owner") state.active.delete(record);
			else state.failed++;
		}
		capturedToolUi = undefined;
		clearPresentationTui();
		const archive = state.active.size === 0 ? finalize(state) : undefined;
		return { restored: state.restored, failed: state.failed, diagnostics: new Map(state.diagnostics), archive };
	};
	return Object.freeze({
		decorateToolRendererSelection(subtype: RendererSubtype, original: unknown, instance: object, args: unknown[]) {
			if (typeof original !== "function") return undefined;
			capturedToolUi = (instance as { ui?: { requestRender?: (force?: boolean) => void } }).ui ?? capturedToolUi;
			notePresentationTui(capturedToolUi);
			if (state.snapshot.style === "compact-box") {
				const toolName = (instance as { toolName?: unknown }).toolName;
				// Compact-box owns the complete call/result topology. Do not select and
				// conditionally fall back to a custom renderer here: that is how one tool
				// can retain its native inset while neighboring tools start at column 0.
				// A normalized context keeps the shell aligned across small Pi context
				// shape changes without handing ownership back to the native renderer.
				neutralizeToolContainerBackground(instance);
				if (subtype === "tool-call-renderer")
					return (callArgs: unknown, theme: unknown, rawContext: unknown) => {
						const normalizedArgs = isObject(callArgs) ? callArgs : {};
						if (!validCallArgs([normalizedArgs, theme, rawContext])) note(state, `${subtype}-normalized-context`);
						const context = normalizeToolRenderContext(instance, rawContext, normalizedArgs);
						const component = renderBoxedToolCall(
							toolName,
							normalizedArgs as Record<string, unknown>,
							theme as never,
							context as never,
						);
						if (component === EMPTY_BATCH_COMPONENT) hideBatchMember(instance);
						return component;
					};
				return (result: unknown, options: unknown, theme: unknown, rawContext: unknown) => {
					const normalizedResult =
						isObject(result) && Array.isArray(ownData(result, "content"))
							? (result as { content?: readonly unknown[]; details?: unknown })
							: { content: [] };
					const normalizedOptions = {
						expanded: isObject(options) && typeof ownData(options, "expanded") === "boolean"
							? (ownData(options, "expanded") as boolean)
							: false,
						isPartial: isObject(options) && typeof ownData(options, "isPartial") === "boolean"
							? (ownData(options, "isPartial") as boolean)
							: false,
					};
					if (!validResultArgs([normalizedResult, normalizedOptions, theme, rawContext]))
						note(state, `${subtype}-normalized-context`);
					const hostArgs = ownData(instance, "args");
					const context = normalizeToolRenderContext(instance, rawContext, isObject(hostArgs) ? hostArgs : {});
					const component = renderBoxedToolResult(
						toolName,
						normalizedResult,
						normalizedOptions,
						theme as never,
						context as never,
					);
					if (component === EMPTY_BATCH_COMPONENT) hideBatchMember(instance);
					return component;
				};
			}
			const renderer = Reflect.apply(original, instance, args);
			if (typeof renderer !== "function") return renderer;
			return function (this: unknown, ...rendererArgs: unknown[]) {
				const valid = subtype === "tool-call-renderer" ? validCallArgs(rendererArgs) : validResultArgs(rendererArgs);
				if (!valid) {
					note(state, `${subtype}-malformed-context`);
					return Reflect.apply(renderer, this, rendererArgs);
				}
				const component = Reflect.apply(renderer, this, rendererArgs);
				if (!isObject(component)) return component;
				const descriptors = renderDescriptor(component);
				if (descriptors !== false && descriptors.native && piOmpThemeWrappers.has(descriptors.native)) {
					note(state, `${subtype}-owner-conflict`);
					return component;
				}
				if (!descriptors) {
					note(state, `${subtype}-unsafe-render-descriptor`);
					return component;
				}
				const record = state.decorated.get(component);
				if (record) {
					record.context = rendererArgs.at(-1) as ToolRenderContext;
					return component;
				}
				const next = createRecord(
					state,
					component,
					descriptors.native as RenderFunction,
					rendererArgs.at(-1) as ToolRenderContext,
					subtype === "tool-call-renderer" ? "call" : "result",
					descriptors,
				);
				installDecoration(state, next);
				return component;
			};
		},
		getDiagnostics: () => new Map(state.diagnostics),
		getFinalArchive: () => state.archive,
		getActiveRecordCount: () => state.active.size,
		dispose,
	});
}

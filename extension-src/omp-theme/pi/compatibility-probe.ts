import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	InteractiveMode,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	decorateMessageRender,
	decorateMessageUpdate,
	type MessageDecorationSnapshot,
} from "../features/messages/index.js";
import { withCachedHighlight } from "../features/messages/markdown-highlight-cache.js";
import { renderSpecialMessageBlock, type SpecialBlockSubtype } from "../features/messages/special-blocks.js";
import { renderBashExecutionBox } from "../features/tools/bash-execution.js";
import { createToolDecorationOwner } from "../features/tools/index.js";
import {
	type CompatibilityRecord,
	currentGeneration,
	installDelegatingPatch,
	nextGeneration,
} from "./compatibility-registry.js";

/**
 * Certification is identity-first, never version-pinned: a surface is certified
 * when the runtime method (or class constructor, for additive installs) matches a
 * recorded name/arity/source identity. Modular runtimes use exact fingerprints;
 * Pi's minified bundle uses stable source markers because bundling rewrites local
 * names and whitespace. Pi version strings are informational only and never gate
 * installation — changed identities degrade that single surface to its native
 * fallback while every other surface continues.
 */
/** Compatibility is decided from the live native identities, not a Pi version allowlist. */
export const COMPATIBILITY_BASIS = "runtime-identity" as const;

/** A recorded native identity for one certified surface. */
export interface KnownNativeIdentity {
	readonly name: string;
	readonly arity: number;
	readonly fingerprint: string;
	/** Stable source markers used when Pi's bundled minifier rewrites the fingerprint. */
	readonly sourceMarkers?: readonly string[];
}

/**
 * Registry of recorded native identities per surface. A surface matches when the
 * runtime function has the same name and arity plus either an exact source
 * fingerprint or the stable markers recorded for Pi's bundled runtime. A matching
 * identity is evidence of the shipped native method, not a cryptographic proof:
 * code loaded before this module could spoof the same function source. Unrecorded
 * identities therefore fall back natively per surface.
 */
export const KNOWN_NATIVE_IDENTITIES: Readonly<Record<string, readonly KnownNativeIdentity[]>> = Object.freeze({
	"native-markdown-theme:getMarkdownThemeWithSettings": Object.freeze([
		Object.freeze({
			name: "getMarkdownThemeWithSettings",
			arity: 0,
			fingerprint: "5f63d168",
		}),
		Object.freeze({
			name: "getMarkdownThemeWithSettings",
			arity: 0,
			fingerprint: "e177a5a7",
			sourceMarkers: Object.freeze(["getMarkdownTheme()", "codeBlockIndent", "getCodeBlockIndent"]),
		}),
	]),
	"native-assistant-message:render": Object.freeze([
		Object.freeze({
			name: "render",
			arity: 1,
			fingerprint: "2a39243f",
		}),
		Object.freeze({
			name: "render",
			arity: 1,
			fingerprint: "a9be09a3",
			sourceMarkers: Object.freeze(["hasToolCalls", "OSC133_ZONE_START", "OSC133_ZONE_END", "OSC133_ZONE_FINAL"]),
		}),
	]),
	"native-assistant-message:updateContent": Object.freeze([
		Object.freeze({
			name: "updateContent",
			arity: 1,
			fingerprint: "4a2f15ff",
		}),
		// This identity records the later implementation shape; default parameters
		// do not count toward Function.length, so the arity remains 1.
		Object.freeze({
			name: "updateContent",
			arity: 1,
			fingerprint: "d2114491",
		}),
		Object.freeze({
			name: "updateContent",
			arity: 1,
			fingerprint: "356b7e83",
			sourceMarkers: Object.freeze([
				"isStreaming",
				"contentContainer",
				"createMarkdownTransform",
				"thinkingText",
				"hideThinkingBlock",
			]),
		}),
		// Pi 0.85.0 keeps the same streaming/thinking contract in its modular
		// runtime but wraps thinking blocks in MouseRegion for click-to-toggle.
		Object.freeze({
			name: "updateContent",
			arity: 1,
			fingerprint: "80e338d2",
		}),
	]),
	"native-compaction-message:updateDisplay": Object.freeze([
		Object.freeze({
			name: "updateDisplay",
			arity: 0,
			fingerprint: "f8c44e78",
		}),
		Object.freeze({
			name: "updateDisplay",
			arity: 0,
			fingerprint: "5118a51d",
			sourceMarkers: Object.freeze(["Compacted from", "customMessageLabel", "customMessageText"]),
		}),
	]),
	"native-branch-message:updateDisplay": Object.freeze([
		Object.freeze({
			name: "updateDisplay",
			arity: 0,
			fingerprint: "415d57b7",
		}),
		Object.freeze({
			name: "updateDisplay",
			arity: 0,
			fingerprint: "2185274e",
			sourceMarkers: Object.freeze(["Branch Summary", "customMessageLabel", "customMessageText"]),
		}),
	]),
	"native-skill-message:updateDisplay": Object.freeze([
		Object.freeze({
			name: "updateDisplay",
			arity: 0,
			fingerprint: "48099ea6",
		}),
		Object.freeze({
			name: "updateDisplay",
			arity: 0,
			fingerprint: "4051fd65",
			sourceMarkers: Object.freeze(["skillBlock", "customMessageLabel", "customMessageText"]),
		}),
	]),
	"native-custom-message:rebuild": Object.freeze([
		Object.freeze({
			name: "rebuild",
			arity: 0,
			fingerprint: "76ae2e3a",
		}),
		Object.freeze({
			name: "rebuild",
			arity: 0,
			fingerprint: "b89987cc",
			sourceMarkers: Object.freeze(["customRenderer", "customComponent", "customMessageLabel", "customMessageText"]),
		}),
	]),
	"tool-call-renderer:getCallRenderer": Object.freeze([
		Object.freeze({
			name: "getCallRenderer",
			arity: 0,
			fingerprint: "951ea0e0",
		}),
		Object.freeze({
			name: "getCallRenderer",
			arity: 0,
			fingerprint: "e50613b7",
			sourceMarkers: Object.freeze(["builtInToolDefinition", "renderCall", "toolDefinition"]),
		}),
		// Pi 0.85.0 moved built-in renderer lookup to InteractiveMode and leaves
		// this selector responsible only for the definition passed by the host.
		Object.freeze({
			name: "getCallRenderer",
			arity: 0,
			fingerprint: "e0a9ed86",
		}),
		Object.freeze({
			name: "getCallRenderer",
			arity: 0,
			fingerprint: "73116365",
			sourceMarkers: Object.freeze(["toolDefinition", "renderCall"]),
		}),
	]),
	"tool-result-renderer:getResultRenderer": Object.freeze([
		Object.freeze({
			name: "getResultRenderer",
			arity: 0,
			fingerprint: "8a25cd71",
		}),
		Object.freeze({
			name: "getResultRenderer",
			arity: 0,
			fingerprint: "28c4dc22",
			sourceMarkers: Object.freeze(["builtInToolDefinition", "renderResult", "toolDefinition"]),
		}),
		// Pi 0.85.0 uses the same definition hand-off for result renderers.
		Object.freeze({
			name: "getResultRenderer",
			arity: 0,
			fingerprint: "1567dcf4",
		}),
		Object.freeze({
			name: "getResultRenderer",
			arity: 0,
			fingerprint: "d613a2a3",
			sourceMarkers: Object.freeze(["toolDefinition", "renderResult"]),
		}),
	]),
	"native-bash-execution:render": Object.freeze([
		Object.freeze({
			// The additive render patch is certified by the class constructor identity
			// (name/arity/source fingerprint): the class defines no own `render`, so
			// the installed own method is the only one and the inherited Container
			// render is the native fallback.
			name: "BashExecutionComponent",
			arity: 2,
			fingerprint: "a5b5abca",
		}),
		Object.freeze({
			name: "BashExecutionComponent",
			arity: 2,
			fingerprint: "98d22d96",
			sourceMarkers: Object.freeze(["outputLines", "contentContainer", "Running...", "setComplete", "appendOutput"]),
		}),
	]),
});

/** Primary (first-recorded) fingerprint per surface, for diagnostics and back-compat. */
export const TRUSTED_NATIVE_FINGERPRINTS: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(
		Object.entries(KNOWN_NATIVE_IDENTITIES).map(([key, identities]) => [key, identities[0]!.fingerprint]),
	),
);

export interface CompatibilityDescriptorSnapshot {
	readonly kind: "data" | "accessor";
	readonly value?: unknown;
	readonly get?: unknown;
	readonly set?: unknown;
	readonly writable?: boolean;
	readonly enumerable: boolean;
	readonly configurable: boolean;
}

export interface CompatibilityRecordSnapshot {
	readonly feature: CompatibilityRecord["feature"];
	readonly subtype: CompatibilityRecord["subtype"];
	readonly method: PropertyKey;
	readonly shape: string;
	readonly piVersion: string;
	readonly compatibilityBasis: string;
	readonly generation: number;
	readonly disposed: boolean;
	readonly diagnostic: string | undefined;
}

export type CompatibilityFallbackCause = "disabled" | "incompatible" | "conflict" | "installation";

export interface CompatibilityProbeReport {
	attemptedVersion: string;
	piVersion: string;
	compatibilityBasis: typeof COMPATIBILITY_BASIS;
	generation: number;
	recordSnapshots: readonly CompatibilityRecordSnapshot[];
	unsupported: ReadonlyArray<{
		subtype: CompatibilityRecord["subtype"];
		method: PropertyKey;
		reason: string;
		cause: CompatibilityFallbackCause;
	}>;
	delegationMarkers: readonly string[];
	certification: readonly {
		readonly attemptedVersion: string;
		readonly matchedIdentity: KnownNativeIdentity | undefined;
		readonly knownIdentities: readonly KnownNativeIdentity[];
		readonly feature: CompatibilityRecord["feature"];
		readonly subtype: CompatibilityRecord["subtype"];
		readonly target: object;
		readonly method: string;
		readonly descriptor: CompatibilityDescriptorSnapshot | undefined;
		readonly name: string | undefined;
		readonly arity: number | undefined;
		readonly fingerprint: string | undefined;
		readonly adapterId: string | undefined;
		readonly status: "certified" | "native-fallback";
		readonly fallbackReason?: string;
		readonly actualPreinstall: CompatibilityDescriptorSnapshot | undefined;
	}[];
	getRuntimeDiagnostics: () => ReadonlyMap<string, number>;
	getFinalDiagnostics: () => Readonly<import("../features/tools/index.js").ToolDiagnosticArchive> | undefined;
	getActiveToolRecordCount: () => number;
	disposeOwner: () => void;
}

export interface TargetSpec {
	feature: CompatibilityRecord["feature"];
	subtype: CompatibilityRecord["subtype"];
	target: object;
	method: string;
	adapterId: string | undefined;
	status: "certified" | "native-fallback";
	fallbackReason?: string;
	/** "add-method" installs a new own method; the class constructor fingerprint certifies the target. */
	kind?: "method" | "add-method";
	/** Function name to verify (defaults to `method`; additive patches verify the class constructor name). */
	identityName?: string;
	/** Expected arity (defaults to the standard per-method rule; additive patches verify the constructor arity). */
	arity?: number;
}

export function fingerprint(value: unknown): string | undefined {
	if (typeof value !== "function") return undefined;
	let hash = 2166136261;
	for (const character of Function.prototype.toString.call(value)) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function isBundledPiRuntime(): boolean {
	if (process.env.PI_CODING_AGENT !== "true" && process.env.AI_AGENT !== "pi") return false;
	const argv1 = process.argv[1];
	return (
		typeof argv1 === "string" &&
		argv1.length > 0 &&
		isAbsolute(argv1) &&
		/[\\/]dist[\\/]bundle[\\/]/i.test(resolve(argv1))
	);
}

function matchesSourceMarkers(value: Function, markers: readonly string[] | undefined): boolean {
	if (!markers || markers.length === 0) return false;
	const source = Function.prototype.toString.call(value);
	return markers.every((marker) => source.includes(marker));
}

/**
 * Match one native method without consulting Pi's version number. Exact source
 * identity is preferred; bundled builds may use stable contract markers because
 * minification can rewrite an otherwise unchanged method.
 */
export function matchKnownNativeIdentity(
	key: string,
	value: unknown,
	options: { readonly bundledRuntime?: boolean } = {},
): KnownNativeIdentity | undefined {
	if (typeof value !== "function") return undefined;
	const hash = fingerprint(value);
	const bundledRuntime = options.bundledRuntime ?? isBundledPiRuntime();
	return (KNOWN_NATIVE_IDENTITIES[key] ?? []).find(
		(identity) =>
			value.name === identity.name &&
			value.length === identity.arity &&
			(hash === identity.fingerprint || (bundledRuntime && matchesSourceMarkers(value, identity.sourceMarkers))),
	);
}

function knownIdentityMatches(spec: TargetSpec, value: unknown): KnownNativeIdentity | undefined {
	return matchKnownNativeIdentity(`${spec.subtype}:${spec.method}`, value);
}

function matchedNativeIdentity(spec: TargetSpec): KnownNativeIdentity | undefined {
	if (spec.kind === "add-method") {
		// Additive install: the prototype must not already own the method (it is
		// inherited), the class constructor identity must match a recorded build,
		// and the inherited method becomes the native fallback for the delegate.
		if (Object.getOwnPropertyDescriptor(spec.target, spec.method)) return undefined;
		const ctor = Object.getOwnPropertyDescriptor(spec.target, "constructor")?.value;
		return knownIdentityMatches(spec, ctor);
	}
	const descriptor = Object.getOwnPropertyDescriptor(spec.target, spec.method);
	if (descriptor?.writable !== true || descriptor.configurable !== true) return undefined;
	return knownIdentityMatches(spec, descriptor.value);
}

function trustedNativeIdentity(spec: TargetSpec): unknown {
	const identity = matchedNativeIdentity(spec);
	if (!identity) return undefined;
	if (spec.kind === "add-method") {
		const inherited = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(spec.target), spec.method)?.value;
		return typeof inherited === "function" ? inherited : undefined;
	}
	return Object.getOwnPropertyDescriptor(spec.target, spec.method)?.value;
}

export interface PiVersionResolution {
	resolvePackageEntry?: (packageName: string) => string;
	readFile?: (path: string) => string;
}

/**
 * The bundled Node/RPC runtime intentionally has no filesystem module identity
 * for the host package: extensions receive it through jiti's virtual modules.
 * Use the process entrypoint for diagnostics before resolving the extension's
 * own peer dependency, which may be an older development copy.
 */
function detectPiVersionFromHostProcess(readFile: (path: string) => string): string | undefined {
	if (process.env.PI_CODING_AGENT !== "true" && process.env.AI_AGENT !== "pi") return undefined;
	const argv1 = process.argv[1];
	if (typeof argv1 !== "string" || argv1.length === 0 || !isAbsolute(argv1)) return undefined;
	let directory = dirname(resolve(argv1));
	for (;;) {
		try {
			const packageJson = JSON.parse(readFile(join(directory, "package.json"))) as {
				name?: string;
				version?: string;
			};
			if (packageJson.name === "@earendil-works/pi-coding-agent" && typeof packageJson.version === "string") {
				return packageJson.version;
			}
		} catch {
			// Keep walking toward the filesystem root.
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

export function detectPiVersion(resolution: PiVersionResolution = {}): {
	version: string | undefined;
	diagnostic?: string;
} {
	const readFile = resolution.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const hostProcessVersion = detectPiVersionFromHostProcess(readFile);
	if (hostProcessVersion) return { version: hostProcessVersion };
	const resolvePackageEntry =
		resolution.resolvePackageEntry ??
		((name: string) => {
			try {
				return fileURLToPath(new URL(import.meta.resolve(name)));
			} catch (error) {
				throw new Error(
					`public package entry resolution failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	try {
		const entry = resolvePackageEntry("@earendil-works/pi-coding-agent");
		let directory = dirname(entry);
		for (;;) {
			const packagePath = join(directory, "package.json");
			try {
				const packageJson = JSON.parse(readFile(packagePath)) as { name?: string; version?: string };
				if (packageJson.name === "@earendil-works/pi-coding-agent" && typeof packageJson.version === "string")
					return { version: packageJson.version };
			} catch {
				// Walk upward only; package exports may place the entry below the package root.
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
		return { version: undefined, diagnostic: "Pi package version was not found" };
	} catch (error) {
		return {
			version: undefined,
			diagnostic: `Pi package version detection failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function descriptorSnapshot(descriptor: PropertyDescriptor | undefined): CompatibilityDescriptorSnapshot | undefined {
	if (!descriptor) return undefined;
	return Object.freeze(
		"value" in descriptor
			? {
					kind: "data",
					value: descriptor.value,
					writable: descriptor.writable === true,
					enumerable: descriptor.enumerable === true,
					configurable: descriptor.configurable === true,
				}
			: {
					kind: "accessor",
					get: descriptor.get,
					set: descriptor.set,
					enumerable: descriptor.enumerable === true,
					configurable: descriptor.configurable === true,
				},
	);
}

function certificationRecord(
	spec: TargetSpec,
	attemptedVersion: string | undefined,
	matchedIdentity: KnownNativeIdentity | undefined,
	evidence = Object.getOwnPropertyDescriptor(spec.target, spec.method),
) {
	const descriptor = evidence;
	const value = descriptor?.value;
	return {
		attemptedVersion: attemptedVersion ?? "unknown",
		matchedIdentity,
		knownIdentities: KNOWN_NATIVE_IDENTITIES[`${spec.subtype}:${spec.method}`] ?? [],
		feature: spec.feature,
		subtype: spec.subtype,
		target: spec.target,
		method: spec.method,
		descriptor: descriptorSnapshot(descriptor),
		name: typeof value === "function" ? value.name : undefined,
		arity: typeof value === "function" ? value.length : undefined,
		fingerprint: fingerprint(value),
		adapterId: spec.adapterId,
		status: spec.status,
		...(spec.fallbackReason ? { fallbackReason: spec.fallbackReason } : {}),
	};
}

function shape(spec: TargetSpec): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(spec.target, spec.method);
	// Additive installs need an unowned slot (the method is inherited); every
	// other patch requires the native own writable/configurable method.
	if (spec.kind === "add-method") return descriptor === undefined;
	return typeof descriptor?.value === "function" && descriptor.writable === true && descriptor.configurable === true;
}

export interface CompatibilityProbeOptions {
	markers?: Set<string>;
	config?: Readonly<{
		messages: {
			enabled: boolean;
			assistantPrefix: boolean;
			specialBlocks: boolean;
			hideThinkingLabel: boolean;
			hideInterimText: boolean;
		};
		tools: { enabled: boolean; style: string; maxCollapsedLines: number; maxExpandedLines: number; dimOutput: boolean };
		theme?: { cacheHighlight?: boolean };
		preset: string;
	}>;
	toolSnapshot?: Readonly<{ callMarker?: string; resultMarker?: string; style?: "marker" | "compact-box" }>;
	messageSnapshot?: MessageDecorationSnapshot;
}

function isSpecialBlock(spec: TargetSpec): boolean {
	return spec.feature === "messages" && spec.status === "certified" && spec.adapterId === "message-block-boxed-v1";
}

function createFallbackRecord(
	spec: TargetSpec,
	piVersion: string | undefined,
	generation: number,
	reason: string,
): CompatibilityRecord {
	return {
		feature: spec.feature,
		subtype: spec.subtype,
		target: spec.target,
		owner: spec.target,
		method: spec.method,
		originalIdentity: Reflect.get(spec.target, spec.method),
		piVersion: piVersion ?? "unknown",
		compatibilityBasis: COMPATIBILITY_BASIS,
		shape: "unsupported",
		diagnostic: reason,
		generation,
		disposed: true,
		disposer: () => {},
	};
}

function probeDiagnostic(spec: TargetSpec, identity: unknown): string {
	if (!shape(spec)) return "target method shape is not an own writable/configurable function";
	if (identity === undefined)
		return "runtime native identity (name, arity, fingerprint, or bundled source markers) matched no recorded Pi surface";
	return "recorded native identity verified; certified guarded decoration enabled";
}

function surfaceDisabled(spec: TargetSpec, config: CompatibilityProbeOptions["config"]): boolean {
	if (!config) return false;
	// A pure render-cost surface: it changes no output, so it is gated on its own
	// switch rather than on whether message styling is enabled.
	if (spec.subtype === "native-markdown-theme") return config.theme?.cacheHighlight === false;
	if (spec.feature === "tools") return !config.tools.enabled;
	if (!config.messages.enabled) return true;
	if (spec.subtype === "native-assistant-message" && spec.method === "render") return !config.messages.assistantPrefix;
	if (spec.subtype === "native-assistant-message" && spec.method === "updateContent")
		return !config.messages.hideThinkingLabel && !config.messages.hideInterimText;
	if (isSpecialBlock(spec)) return !config.messages.specialBlocks;
	return true;
}

interface ProbeSpecResult {
	record: CompatibilityRecord;
	reason: string;
	fallback: boolean;
	fallbackCause?: CompatibilityFallbackCause;
}

function probeSpec(options: {
	spec: TargetSpec;
	piVersion: string | undefined;
	generation: number;
	markers: Set<string>;
	config?: CompatibilityProbeOptions["config"];
	messageSnapshot: MessageDecorationSnapshot | undefined;
	toolOwner: ReturnType<typeof createToolDecorationOwner> | undefined;
}): ProbeSpecResult {
	const { spec, piVersion, generation, markers, config, toolOwner, messageSnapshot } = options;
	const identity = trustedNativeIdentity(spec);
	const diagnostic = probeDiagnostic(spec, identity);
	const disabled = surfaceDisabled(spec, config);
	if (disabled) {
		const reason = "native fallback: surface disabled by normalized configuration";
		return {
			record: createFallbackRecord(spec, piVersion, generation, reason),
			reason,
			fallback: true,
			fallbackCause: "disabled",
		};
	}
	const compatible = identity !== undefined && shape(spec);
	const result = installDelegatingPatch({
		feature: spec.feature,
		subtype: spec.subtype,
		target: spec.target,
		method: spec.method,
		piVersion: piVersion ?? "unknown",
		compatibilityBasis: COMPATIBILITY_BASIS,
		shape: compatible,
		generation,
		expectedIdentity: identity,
		hasExpectedIdentity: true,
		diagnostic,
		...(spec.kind ? { kind: spec.kind } : {}),
		delegate: (original, target, args) => {
			markers.add(`${spec.subtype}:delegated`);
			if (spec.subtype === "native-bash-execution")
				return (
					renderBashExecutionBox(target, args) ??
					Reflect.apply(original as (...values: unknown[]) => unknown, target, args)
				);
			if (spec.feature === "tools")
				return (
					toolOwner?.decorateToolRendererSelection(
						spec.subtype as "tool-call-renderer" | "tool-result-renderer",
						original,
						target,
						args,
					) ?? Reflect.apply(original as (...values: unknown[]) => unknown, target, args)
				);
			if (spec.subtype === "native-markdown-theme")
				return withCachedHighlight(Reflect.apply(original as (...values: unknown[]) => unknown, target, args));
			if (spec.subtype === "native-assistant-message") {
				if (spec.method === "updateContent") return decorateMessageUpdate(original, target, args, messageSnapshot);
				return decorateMessageRender(original, target, args, messageSnapshot);
			}
			return renderSpecialMessageBlock(spec.subtype as SpecialBlockSubtype, original, target, args);
		},
	});
	const fallback = result.status === "skipped";
	const fallbackCause: CompatibilityFallbackCause | undefined = fallback
		? !compatible
			? "incompatible"
			: result.record.shape === "conflict"
				? "conflict"
				: "installation"
		: undefined;
	return {
		record: result.record,
		reason: result.reason ?? result.record.diagnostic ?? "skipped",
		fallback,
		...(fallbackCause ? { fallbackCause } : {}),
	};
}

export const targetSpecs: readonly TargetSpec[] = [
	{
		feature: "messages",
		subtype: "native-markdown-theme",
		target: InteractiveMode.prototype,
		method: "getMarkdownThemeWithSettings",
		adapterId: "markdown-highlight-cache-v1",
		status: "certified",
	},
	{
		feature: "messages",
		subtype: "native-assistant-message",
		target: AssistantMessageComponent.prototype,
		method: "render",
		adapterId: "message-prefix-osc133-v1",
		status: "certified",
	},
	{
		feature: "messages",
		subtype: "native-assistant-message",
		target: AssistantMessageComponent.prototype,
		method: "updateContent",
		adapterId: "message-thinking-collapse-v1",
		status: "certified",
	},
	{
		feature: "messages",
		subtype: "native-compaction-message",
		target: CompactionSummaryMessageComponent.prototype,
		method: "updateDisplay",
		adapterId: "message-block-boxed-v1",
		status: "certified",
	},
	{
		feature: "messages",
		subtype: "native-branch-message",
		target: BranchSummaryMessageComponent.prototype,
		method: "updateDisplay",
		adapterId: "message-block-boxed-v1",
		status: "certified",
	},
	{
		feature: "messages",
		subtype: "native-skill-message",
		target: SkillInvocationMessageComponent.prototype,
		method: "updateDisplay",
		adapterId: "message-block-boxed-v1",
		status: "certified",
	},
	{
		feature: "messages",
		subtype: "native-custom-message",
		target: CustomMessageComponent.prototype,
		method: "rebuild",
		adapterId: "message-block-boxed-v1",
		status: "certified",
	},
	{
		feature: "tools",
		subtype: "tool-call-renderer",
		target: ToolExecutionComponent.prototype,
		method: "getCallRenderer",
		adapterId: "tool-renderer-component-v1",
		status: "certified",
	},
	{
		feature: "tools",
		subtype: "tool-result-renderer",
		target: ToolExecutionComponent.prototype,
		method: "getResultRenderer",
		adapterId: "tool-renderer-component-v1",
		status: "certified",
	},
	{
		feature: "tools",
		subtype: "native-bash-execution",
		target: BashExecutionComponent.prototype,
		method: "render",
		kind: "add-method",
		identityName: "BashExecutionComponent",
		arity: 2,
		adapterId: "bash-execution-box-v1",
		status: "certified",
	},
];

/**
 * The live report below is the certification table: it records the actual Pi
 * version, descriptor, and identity seen in this process for every surface.
 */

const reportStates = new WeakMap<
	object,
	{ records: CompatibilityRecord[]; toolOwner: ReturnType<typeof createToolDecorationOwner> | undefined }
>();

export function probePiCompatibility(
	piVersion: string | undefined,
	options: Set<string> | CompatibilityProbeOptions = new Set(),
): CompatibilityProbeReport {
	const markers = options instanceof Set ? options : (options.markers ?? new Set<string>());
	const generation = nextGeneration();
	const toolSpecs = targetSpecs.filter((spec) => spec.feature === "tools");
	let toolOwner: ReturnType<typeof createToolDecorationOwner> | undefined;
	if (
		toolSpecs.some((spec) => trustedNativeIdentity(spec) !== undefined) &&
		(options instanceof Set || options.config?.tools.enabled !== false)
	) {
		toolOwner = createToolDecorationOwner(options instanceof Set ? {} : options.toolSnapshot);
	}
	const evidence = Object.freeze(
		targetSpecs.map((spec) =>
			Object.freeze({
				subtype: spec.subtype,
				method: spec.method,
				target: spec.target,
				descriptor: Object.getOwnPropertyDescriptor(spec.target, spec.method),
				value: Object.getOwnPropertyDescriptor(spec.target, spec.method)?.value,
			}),
		),
	);
	const evidenceByKey = new Map(evidence.map((item) => [`${item.subtype}:${String(item.method)}`, item]));
	const records: CompatibilityRecord[] = [];
	const unsupported: Array<{
		subtype: CompatibilityRecord["subtype"];
		method: PropertyKey;
		reason: string;
		cause: CompatibilityFallbackCause;
	}> = [];
	const certification: NonNullable<CompatibilityProbeReport["certification"]>[number][] = [];
	for (const spec of targetSpecs) {
		const captured = evidenceByKey.get(`${spec.subtype}:${String(spec.method)}`);
		const preinstallDescriptor = captured?.descriptor;
		// Captured before install: the runtime identity is still the pristine native
		// method (or class constructor for additive installs) at this point.
		const matchedIdentity = matchedNativeIdentity(spec);
		const result = probeSpec({
			messageSnapshot: options instanceof Set ? undefined : options.messageSnapshot,
			spec,
			piVersion,
			generation,
			markers,
			config: options instanceof Set ? undefined : options.config,
			toolOwner,
		});
		records.push(result.record);
		const certificate = certificationRecord(spec, piVersion, matchedIdentity, preinstallDescriptor);
		certification.push({
			...certificate,
			attemptedVersion: piVersion ?? "unknown",
			actualPreinstall: descriptorSnapshot(preinstallDescriptor),
			status: result.fallback ? "native-fallback" : "certified",
			...(result.fallback ? { fallbackReason: result.reason } : {}),
		});
		if (result.fallback)
			unsupported.push({
				subtype: spec.subtype,
				method: spec.method,
				reason: result.reason,
				cause: result.fallbackCause ?? "installation",
			});
	}
	const report: CompatibilityProbeReport = {
		attemptedVersion: piVersion ?? "unknown",
		piVersion: piVersion ?? "unknown",
		compatibilityBasis: COMPATIBILITY_BASIS,
		generation: currentGeneration(),
		recordSnapshots: Object.freeze(
			records.map((record) =>
				Object.freeze({
					feature: record.feature,
					subtype: record.subtype,
					method: record.method,
					shape: record.shape,
					piVersion: record.piVersion,
					compatibilityBasis: record.compatibilityBasis,
					generation: record.generation,
					disposed: record.disposed,
					diagnostic: record.diagnostic,
				}),
			),
		),
		unsupported: Object.freeze(unsupported.map((item) => Object.freeze({ ...item }))),
		delegationMarkers: Object.freeze([...markers]),
		certification: Object.freeze(certification.map((item) => Object.freeze({ ...item }))),
		getRuntimeDiagnostics: () => toolOwner?.getDiagnostics() ?? new Map(),
		getFinalDiagnostics: () => toolOwner?.getFinalArchive(),
		getActiveToolRecordCount: () => toolOwner?.getActiveRecordCount() ?? 0,
		disposeOwner: () => {
			toolOwner?.dispose();
		},
	};
	Object.freeze(report);
	reportStates.set(report, { records, toolOwner });
	return report;
}

export type CompatibilityCleanupResult = Readonly<{
	complete: boolean;
	retryablePrototypeRecords: number;
	retryableToolRecords: number;
	finalDiagnostics?: Readonly<import("../features/tools/index.js").ToolDiagnosticArchive>;
}>;

export function disposePiCompatibilityProbe(report: CompatibilityProbeReport): CompatibilityCleanupResult {
	const state = reportStates.get(report);
	if (!state) return { complete: true, retryablePrototypeRecords: 0, retryableToolRecords: 0 };
	for (const record of state.records) record.disposer();
	report.disposeOwner();
	const retryablePrototypeRecords = state.records.filter((record) => !record.disposed).length;
	const finalDiagnostics = report.getFinalDiagnostics();
	const retryableToolRecords = report.getActiveToolRecordCount();
	const toolOwnerWasCreated = report.recordSnapshots.some(
		(record) => record.feature === "tools" && record.shape === "installed",
	);
	return {
		complete:
			retryablePrototypeRecords === 0 &&
			retryableToolRecords === 0 &&
			(!toolOwnerWasCreated || finalDiagnostics !== undefined),
		retryablePrototypeRecords,
		retryableToolRecords,
		...(finalDiagnostics ? { finalDiagnostics } : {}),
	};
}

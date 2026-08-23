import { boundedDiagnostics } from "../domain/config-diagnostics.js";
import { DEFAULT_CONFIG, normalizeConfig, resolveConfigDetailed } from "../domain/config-normalization.js";
import type { NormalizedPiOmpThemeConfig } from "../domain/config-types.js";
import type { StartupDetailItem, StartupReason } from "../features/startup/index.js";
import { createDoctor, type DoctorOperationalState } from "./doctor.js";
import { PiOmpThemeRuntimeController } from "./runtime.js";

export interface StartupResourceDiscovery {
	readonly skillPaths?: readonly string[];
	readonly promptPaths?: readonly string[];
	readonly themePaths?: readonly string[];
	/** Raw system prompt text; word/line counts are computed outside render. */
	readonly systemPrompt?: string;
	/** Context files with pre-computed word/line counts (discovery outside render). */
	readonly contextDetails?: readonly { path: string; words: number; lines: number }[];
	/** Active tools with compact source labels (discovery outside render). */
	readonly toolDetails?: readonly { source: string; name: string }[];
	/** Recent sessions for this project (discovery outside render). */
	readonly sessions?: readonly { name: string; timeAgo: string }[];
	readonly models?: number;
}

function countWords(text: string): number {
	return text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split(/\r\n|\r|\n/).length;
	return /\r\n$|\r$|\n$/.test(text) ? lines - 1 : lines;
}

function toStartupResources(resources: StartupResourceDiscovery) {
	const details: StartupDetailItem[] = [];
	if (resources.systemPrompt) {
		const words = countWords(resources.systemPrompt);
		const lines = countLines(resources.systemPrompt);
		if (words > 0 && lines > 0) details.push({ kind: "system", path: "system prompt", words, lines });
	}
	for (const file of resources.contextDetails ?? []) {
		if (file.words > 0 && file.lines > 0) {
			details.push({ kind: "context", path: file.path, words: file.words, lines: file.lines });
		}
	}
	return {
		...(resources.promptPaths ? { contextFiles: resources.promptPaths.length } : {}),
		...(resources.themePaths ? { extensions: resources.themePaths.length } : {}),
		...(resources.skillPaths ? { skills: resources.skillPaths.length } : {}),
		...(resources.models !== undefined ? { models: resources.models } : {}),
		...(resources.toolDetails && resources.toolDetails.length > 0
			? { tools: resources.toolDetails.length, toolDetails: resources.toolDetails }
			: {}),
		...(resources.sessions && resources.sessions.length > 0 ? { sessions: resources.sessions } : {}),
		...(details.length > 0 ? { details } : {}),
	};
}

export interface ConfigReloadPort {
	load(trusted: boolean): Promise<{
		readonly config?: unknown;
		readonly diagnostics?: readonly import("../domain/config-diagnostics.js").ConfigDiagnostic[];
		readonly sources?: Readonly<Record<string, string>>;
		readonly rawSources?: {
			defaults?: unknown;
			global?: unknown;
			project?: unknown;
			environment?: Record<string, string | undefined>;
		};
		readonly productPolicy?: { corePatchGate: "omitted" | "allow" | "deny" };
	}>;
}

export interface AppHost {
	readonly mode: "tui" | "rpc" | "json" | "print";
	readonly hasUI: boolean;
	readonly ui?: Parameters<PiOmpThemeRuntimeController["start"]>[0]["ui"];
	readonly cwd?: string;
	readonly model?: { id?: string; name?: string; provider?: string; reasoning?: boolean };
	readonly thinkingLevel?: string;
	readonly getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	readonly projectTrusted?: boolean;
	readonly extensionStatusProvider?: () => readonly import("../domain/status.js").ExtensionStatus[] | undefined;
	readonly gitRunner?: import("../domain/providers.js").GitCommandRunner;
}

export interface PiOmpThemeApp {
	readonly runtime: PiOmpThemeRuntimeController;
	readonly config: NormalizedPiOmpThemeConfig;
	readonly productPolicy: { corePatchGate: "omitted" | "allow" | "deny" };
	sessionStart(ctx: AppHost, reason?: StartupReason, resources?: StartupResourceDiscovery): void;
	setResources(resources: StartupResourceDiscovery): void;
	applySession(patch: unknown): void;
	setProjectTrusted(trusted: boolean): void;
	setOperationalState(state: DoctorOperationalState): void;
	setProductPolicy(policy: { corePatchGate: "omitted" | "allow" | "deny" }): void;
	reload(): Promise<void>;
	doctor(): Readonly<Record<string, unknown>>;
	sessionShutdown(): void;
	update(
		values: import("../domain/status.js").StatusSnapshot,
		kind?: import("./render-scheduler.js").UpdateClass,
	): void;
}

function submittedSessionPaths(value: unknown, prefix = ""): readonly string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.entries(value).flatMap(([key, nested]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		return [path, ...submittedSessionPaths(nested, path)];
	});
}
function composeSources(
	durable: Readonly<Record<string, string>>,
	resolved: Readonly<Record<string, string>>,
	session: unknown,
): Readonly<Record<string, string>> {
	const next = { ...durable, ...resolved };
	for (const path of submittedSessionPaths(session)) {
		const effectiveSource = resolved[path];
		if (effectiveSource === undefined) delete next[path];
		else next[path] = effectiveSource;
	}
	return next;
}

function mergePatch(base: unknown, patch: unknown): unknown {
	if (patch === undefined) return base;
	if (
		typeof base !== "object" ||
		base === null ||
		Array.isArray(base) ||
		typeof patch !== "object" ||
		patch === null ||
		Array.isArray(patch)
	)
		return patch;
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch as Record<string, unknown>))
		result[key] = mergePatch(result[key], value);
	return result;
}

export function createPiOmpThemeApp(
	initialConfig?: unknown,
	reloadPort?: ConfigReloadPort,
	onConfigChange?: (config: NormalizedPiOmpThemeConfig) => void,
): PiOmpThemeApp {
	const runtime = new PiOmpThemeRuntimeController();
	let config = initialConfig === undefined ? DEFAULT_CONFIG : normalizeConfig(initialConfig);
	let diagnostics: readonly import("../domain/config-diagnostics.js").ConfigDiagnostic[] = [];
	let durableDiagnostics: readonly import("../domain/config-diagnostics.js").ConfigDiagnostic[] = [];
	let durableSources: Readonly<Record<string, string>> = {};
	let sources: Readonly<Record<string, string>> = {};
	let trusted = true;
	let resources: StartupResourceDiscovery | undefined;
	let operational: DoctorOperationalState = {};
	let sessionPatch: unknown;
	let rawSources: {
		defaults?: unknown;
		global?: unknown;
		project?: unknown;
		environment?: Record<string, string | undefined>;
	} = { defaults: initialConfig ?? DEFAULT_CONFIG };
	let productPolicy: { corePatchGate: "omitted" | "allow" | "deny" } = { corePatchGate: "omitted" };
	const resolveAll = () => resolveConfigDetailed({ ...rawSources, session: sessionPatch, projectTrusted: trusted });
	const resolveProductPolicy = () => {
		const values = [rawSources.global, trusted ? rawSources.project : undefined, sessionPatch];
		for (const value of values) {
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const compatibility = (value as Record<string, unknown>).compatibility;
			if (
				compatibility &&
				typeof compatibility === "object" &&
				!Array.isArray(compatibility) &&
				Object.hasOwn(compatibility, "allowCorePatches") &&
				(compatibility as Record<string, unknown>).allowCorePatches === false
			)
				return { corePatchGate: "deny" as const };
		}
		return { corePatchGate: "omitted" as const };
	};
	return {
		runtime,
		get config() {
			return config;
		},
		get productPolicy() {
			return productPolicy;
		},
		sessionStart(ctx, reason = "startup", discoveredResources) {
			trusted = ctx.projectTrusted ?? true;
			resources = discoveredResources;
			operational = {
				...operational,
				provider: ctx.extensionStatusProvider
					? { status: "configured", recovery: "provider will be checked on first snapshot" }
					: { status: "unavailable", recovery: "inject a capability-safe provider" },
				installations: {
					status: config.enabled && config.statusLine.enabled ? "active" : "disabled",
					editor: config.enabled && config.editor.enabled ? "active" : "disabled",
					startup: config.enabled && config.startup.mode !== "off" ? "active" : "disabled",
				},
			};
			const statusProvider = ctx.extensionStatusProvider
				? () => {
						try {
							const result = ctx.extensionStatusProvider?.();
							operational = { ...operational, provider: { status: "available" } };
							return result;
						} catch {
							operational = {
								...operational,
								provider: { status: "unavailable", recovery: "provider threw; retry after recovery" },
							};
							ctx.ui?.notify?.("pi-omp-theme extension statuses unavailable; provider recovery required", "warning");
							return undefined;
						}
					}
				: undefined;
			runtime.start({
				mode: ctx.mode,
				hasUI: ctx.hasUI,
				...(ctx.ui ? { ui: ctx.ui } : {}),
				...(ctx.cwd ? { cwd: ctx.cwd } : {}),
				...(ctx.model ? { model: ctx.model } : {}),
				...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
				config,
				startupReason: reason,
				...(resources ? { resources: toStartupResources(resources) } : {}),
				...(ctx.getContextUsage ? { getContextUsage: ctx.getContextUsage } : {}),
				...(ctx.projectTrusted !== undefined ? { projectTrusted: ctx.projectTrusted } : {}),
				...(ctx.gitRunner ? { gitRunner: ctx.gitRunner } : {}),
				...(statusProvider ? { extensionStatusProvider: statusProvider } : {}),
			});
		},
		setResources(next) {
			resources = next;
			runtime.current?.updateStartupResources(toStartupResources(next));
		},
		applySession(patch) {
			sessionPatch = mergePatch(sessionPatch, patch);
			const resolved = resolveAll();
			config = resolved.config;
			diagnostics = boundedDiagnostics([...durableDiagnostics, ...resolved.diagnostics]);
			sources = composeSources(durableSources, resolved.sources, sessionPatch);
			productPolicy = resolveProductPolicy();
			operational = {
				...operational,
				authorization: { ...(operational.authorization ?? {}), productCorePatchGate: productPolicy.corePatchGate },
			};
			runtime.current?.configure(config);
			operational = {
				...operational,
				installations: { ...(operational.installations ?? {}), configChange: "reconciled" },
			};
			onConfigChange?.(config);
		},
		setProjectTrusted(nextTrusted) {
			trusted = nextTrusted;
		},
		setOperationalState(state) {
			operational = { ...operational, ...state };
		},
		setProductPolicy(policy) {
			productPolicy = policy;
			operational = {
				...operational,
				authorization: { ...(operational.authorization ?? {}), productCorePatchGate: policy.corePatchGate },
			};
		},
		sessionShutdown() {
			runtime.stop();
		},
		update(values, kind = "coalesced") {
			const active = runtime.current;
			if (!active) return;
			active.update(values);
			active.scheduler.schedule(kind);
		},
		reload() {
			if (!reloadPort) {
				runtime.current?.configure(config);
				return Promise.resolve();
			}
			return reloadPort.load(trusted).then((result) => {
				durableDiagnostics = boundedDiagnostics(result.diagnostics ?? []);
				durableSources = result.sources ?? {};
				diagnostics = durableDiagnostics;
				sources = durableSources;
				if (result.config !== undefined) {
					rawSources = result.rawSources ?? { defaults: result.config };
					productPolicy = resolveProductPolicy();
					const resolved = resolveAll();
					config = resolved.config;
					diagnostics = boundedDiagnostics([...durableDiagnostics, ...resolved.diagnostics]);
					sources = composeSources(durableSources, resolved.sources, sessionPatch);
					onConfigChange?.(config);
					operational = {
						...operational,
						authorization: { ...(operational.authorization ?? {}), productCorePatchGate: productPolicy.corePatchGate },
					};
				}
				runtime.current?.configure(config);
				onConfigChange?.(config);
			});
		},
		doctor() {
			return createDoctor({
				config,
				operational,
				diagnostics,
				sources,
				surfaces: {
					status: operational.installations?.status ?? "unknown",
					editor: operational.installations?.editor ?? "unknown",
					startup: operational.installations?.startup ?? "unknown",
					assistantMessage: operational.compatibility?.assistantMessage ?? "unknown",
					specialBlocks: operational.compatibility?.specialBlocks ?? "unknown",
					tools: operational.compatibility?.tools ?? "unknown",
				},
			});
		},
	};
}

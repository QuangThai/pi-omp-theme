import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { diffConfig } from "../domain/config-diff.js";
import type { NormalizedPiOmpThemeConfig } from "../domain/config-types.js";
import type { GitCommandRunner } from "../domain/providers.js";
import type { StatusSnapshot } from "../domain/status.js";
import { normalizeThinkingLevel } from "../domain/status.js";
import { installEditor } from "../features/editor/index.js";
import {
	installStartup,
	type StartupHost,
	type StartupReason,
	type StartupResources,
	type StartupSnapshot,
} from "../features/startup/index.js";
import { installStatusLine } from "../features/status-line/index.js";
import { DisposableStore } from "../shared/disposable-store.js";
import { CachedGitProvider, InMemoryContextProvider, InMemoryUsageProvider } from "./providers.js";
import { RenderScheduler } from "./render-scheduler.js";
import { createSnapshot, replaceSnapshot, type UiSnapshot } from "./snapshot.js";

export interface RuntimeInstallationState {
	readonly status: "installed" | "disabled" | "failed";
	readonly editor: "installed" | "preserved" | "disabled" | "failed";
	readonly startup: "installed" | "disabled" | "failed";
}

export interface PiOmpThemeRuntime {
	generation: number;
	readonly providerIdentity: { git: object; context: object; usage: object };
	readonly installationState: RuntimeInstallationState;
	mode: ExtensionContext["mode"];
	hasUI: boolean;
	disposed: boolean;
	snapshot: UiSnapshot;
	disposables: DisposableStore;
	scheduler: RenderScheduler;
	update(values: StatusSnapshot): void;
	updateStartupResources(resources: StartupResources): void;
	dismissStartup(): void;
	invalidateGit(): void;
	configure(config: NormalizedPiOmpThemeConfig): void;
	dispose(): void;
}

export interface RuntimeHost {
	readonly mode: ExtensionContext["mode"];
	readonly hasUI: boolean;
	readonly ui?: ExtensionUIContext;
	readonly cwd?: string;
	readonly model?: { id?: string; name?: string; provider?: string; reasoning?: boolean } | undefined;
	readonly thinkingLevel?: string | undefined;
	readonly config: NormalizedPiOmpThemeConfig;
	readonly startupReason?: StartupReason;
	readonly provider?: string;
	readonly requestRender?: () => void;
	readonly resources?: StartupResources;
	readonly extensionStatusProvider?: () => readonly import("../domain/status.js").ExtensionStatus[] | undefined;
	readonly gitRunner?: GitCommandRunner;
	getContextUsage?:
		| (() => { tokens: number | null; contextWindow: number; percent: number | null } | undefined)
		| undefined;
}

export function createPiOmpThemeRuntime(
	host: RuntimeHost,
	generation: number,
	requestRender: () => void = () => {},
): PiOmpThemeRuntime {
	let disposed = false;
	const extensionStatuses = (): readonly import("../domain/status.js").ExtensionStatus[] | undefined => {
		if (!host.extensionStatusProvider) return undefined;
		try {
			return host.extensionStatusProvider();
		} catch {
			host.ui?.notify?.("pi-omp-theme extension statuses unavailable; provider recovery required", "warning");
			return [];
		}
	};
	let currentConfig = host.config;
	const disposables = new DisposableStore();
	const scheduler = new RenderScheduler({ requestRender }, generation, () => !disposed);
	const git = new CachedGitProvider(host.gitRunner);
	const contextProvider = new InMemoryContextProvider();
	const usageProvider = new InMemoryUsageProvider();
	const usage = host.getContextUsage?.();
	const initialStatuses = extensionStatuses();
	const initialValues = {
		...(initialStatuses ? { extensionStatuses: initialStatuses } : {}),
		...(host.model?.name || host.model?.id ? { model: host.model.name ?? host.model.id } : {}),
		...(host.model?.provider ? { provider: host.model.provider } : {}),
		...(host.model?.reasoning !== undefined ? { reasoning: host.model.reasoning } : {}),
		...(host.thinkingLevel ? { thinkingLevel: normalizeThinkingLevel(host.thinkingLevel) } : {}),
		...(host.cwd ? { cwd: host.cwd } : {}),
		...(usage
			? {
					context: {
						...(usage.tokens !== null ? { currentTokens: usage.tokens } : {}),
						windowTokens: usage.contextWindow,
						...(usage.percent !== null ? { percent: usage.percent } : {}),
					},
				}
			: {}),
	};
	let currentSnapshot = createSnapshot(generation, 0, initialValues);
	let statusLine: ReturnType<typeof installStatusLine> | undefined;
	let editor: ReturnType<typeof installEditor> | undefined;
	let startup: ReturnType<typeof installStartup> | undefined;
	let installationState: RuntimeInstallationState = {
		status: "disabled",
		editor: "disabled",
		startup: "disabled",
	};
	const startupSnapshot = (config: NormalizedPiOmpThemeConfig): StartupSnapshot => ({
		...currentSnapshot,
		reason: host.startupReason ?? "startup",
		...(host.provider ? { startupProvider: host.provider } : {}),
		...(host.cwd ? { project: host.cwd.split(/[\\/]/).filter(Boolean).at(-1) } : {}),
		preset: config.preset,
		...(host.resources ? { resources: host.resources } : {}),
	});
	const installStatus = () => {
		if (!host.hasUI || host.mode !== "tui" || !host.ui || !currentConfig.enabled || !currentConfig.statusLine.enabled) {
			installationState = { ...installationState, status: "disabled" };
			return;
		}
		try {
			statusLine = installStatusLine({
				host: host.ui,
				config: currentConfig,
				generation,
				initialSnapshot: currentSnapshot,
				isCurrent: () => !disposed,
			});
			if (statusLine) {
				disposables.add(statusLine);
				installationState = { ...installationState, status: "installed" };
			} else installationState = { ...installationState, status: "failed" };
		} catch (error) {
			host.ui.notify?.(
				`pi-omp-theme status unavailable: ${error instanceof Error ? error.message : "installation failed"}`,
				"warning",
			);
			statusLine = undefined;
			installationState = { ...installationState, status: "failed" };
		}
	};
	const installEditorFeature = () => {
		if (!host.hasUI || host.mode !== "tui" || !host.ui || !currentConfig.enabled || !currentConfig.editor.enabled) {
			installationState = { ...installationState, editor: "disabled" };
			return;
		}
		try {
			editor = installEditor({
				host: host.ui,
				config: currentConfig,
				generation,
				initialSnapshot: currentSnapshot,
				isCurrent: () => !disposed,
			});
			if (editor) {
				disposables.add(editor);
				installationState = { ...installationState, editor: editor.preservedPrevious ? "preserved" : "installed" };
			} else installationState = { ...installationState, editor: "failed" };
		} catch (error) {
			host.ui.notify?.(
				`pi-omp-theme editor unavailable: ${error instanceof Error ? error.message : "installation failed"}`,
				"warning",
			);
			editor = undefined;
			installationState = { ...installationState, editor: "failed" };
		}
	};
	const installStartupFeature = () => {
		if (
			!host.hasUI ||
			host.mode !== "tui" ||
			!host.ui ||
			!currentConfig.enabled ||
			currentConfig.startup.mode === "off"
		) {
			installationState = { ...installationState, startup: "disabled" };
			return;
		}
		try {
			startup = installStartup({
				host: { ...(host.ui as unknown as StartupHost), mode: host.mode, hasUI: host.hasUI },
				config: currentConfig,
				snapshot: startupSnapshot(currentConfig),
				generation,
				requestRender,
				timeoutMs: 3000,
				isCurrent: () => !disposed,
			});
			if (startup) {
				disposables.add(startup);
				installationState = { ...installationState, startup: "installed" };
			} else installationState = { ...installationState, startup: "failed" };
		} catch (error) {
			host.ui.notify?.(
				`pi-omp-theme startup unavailable: ${error instanceof Error ? error.message : "installation failed"}`,
				"warning",
			);
			startup = undefined;
			installationState = { ...installationState, startup: "failed" };
		}
	};
	const disposeFeature = (label: string, dispose: (() => void) | undefined): void => {
		if (!dispose) return;
		try {
			dispose();
		} catch (error) {
			host.ui?.notify?.(`pi-omp-theme ${label} cleanup failed; preserving the current owner`, "warning");
			void error;
		}
	};
	const disposeStatus = () => {
		disposeFeature("status", statusLine?.dispose);
		statusLine = undefined;
		installationState = { ...installationState, status: "disabled" };
	};
	const disposeEditor = () => {
		disposeFeature("editor", editor?.dispose);
		editor = undefined;
		installationState = { ...installationState, editor: "disabled" };
	};
	const disposeStartup = () => {
		disposeFeature("startup", startup?.dispose);
		startup = undefined;
		installationState = { ...installationState, startup: "disabled" };
	};
	installStatus();
	installEditorFeature();
	installStartupFeature();
	if (host.cwd && currentConfig.enabled && currentConfig.statusLine.enabled) {
		void git.get(host.cwd).then((value) => {
			if (disposed) return;
			currentSnapshot = replaceSnapshot(currentSnapshot, generation, { ...currentSnapshot, git: value });
			statusLine?.update(currentSnapshot);
			editor?.update(currentSnapshot);
			startup?.update({
				...currentSnapshot,
				reason: host.startupReason ?? "startup",
				...(host.provider ? { startupProvider: host.provider } : {}),
				...(host.cwd ? { project: host.cwd.split(/[\\/]/).filter(Boolean).at(-1) } : {}),
				preset: currentConfig.preset,
				...(host.resources ? { resources: host.resources } : {}),
			});
			requestRender();
		});
	}
	if (usage) {
		contextProvider.set("active", {
			...(usage.tokens !== null ? { currentTokens: usage.tokens } : {}),
			windowTokens: usage.contextWindow,
			...(usage.percent !== null ? { percent: usage.percent } : {}),
		});
	}
	return {
		generation,
		providerIdentity: { git, context: contextProvider, usage: usageProvider },
		get installationState() {
			return installationState;
		},
		mode: host.mode,
		hasUI: host.hasUI,
		snapshot: currentSnapshot,
		disposables,
		scheduler,
		updateStartupResources(resources) {
			if (disposed) return;
			startup?.update({
				...currentSnapshot,
				reason: host.startupReason ?? "startup",
				...(host.provider ? { startupProvider: host.provider } : {}),
				...(host.cwd ? { project: host.cwd.split(/[\\/]/).filter(Boolean).at(-1) } : {}),
				preset: currentConfig.preset,
				resources,
			});
			requestRender();
		},
		dismissStartup() {
			startup?.dismiss();
		},
		update(values) {
			if (disposed) return;
			const liveUsage = host.getContextUsage?.();
			const context = liveUsage
				? {
						...(liveUsage.tokens !== null ? { currentTokens: liveUsage.tokens } : {}),
						windowTokens: liveUsage.contextWindow,
						...(liveUsage.percent !== null ? { percent: liveUsage.percent } : {}),
					}
				: undefined;
			const statuses = extensionStatuses();
			currentSnapshot = replaceSnapshot(currentSnapshot, generation, {
				...currentSnapshot,
				...values,
				...(context ? { context } : {}),
				...(statuses ? { extensionStatuses: statuses } : {}),
			});
			statusLine?.update(currentSnapshot);
			editor?.update(currentSnapshot);
			startup?.update({
				...currentSnapshot,
				reason: host.startupReason ?? "startup",
				...(host.provider ? { startupProvider: host.provider } : {}),
				...(host.cwd ? { project: host.cwd.split(/[\\/]/).filter(Boolean).at(-1) } : {}),
				preset: currentConfig.preset,
				...(host.resources ? { resources: host.resources } : {}),
			});
		},
		configure(nextConfig) {
			if (disposed) return;
			const previous = currentConfig;
			const impactPlan = diffConfig(previous, nextConfig);
			if (impactPlan.impacts.length === 0) return;
			currentConfig = nextConfig;
			const statusChanged =
				JSON.stringify(previous.statusLine) !== JSON.stringify(nextConfig.statusLine) ||
				previous.placement !== nextConfig.placement ||
				previous.enabled !== nextConfig.enabled;
			const editorChanged =
				JSON.stringify(previous.editor) !== JSON.stringify(nextConfig.editor) ||
				previous.enabled !== nextConfig.enabled;
			const startupChanged =
				JSON.stringify(previous.startup) !== JSON.stringify(nextConfig.startup) ||
				previous.enabled !== nextConfig.enabled;
			if (statusChanged) {
				disposeStatus();
				currentConfig = nextConfig;
				installStatus();
			}
			if (editorChanged) {
				disposeEditor();
				currentConfig = nextConfig;
				installEditorFeature();
			}
			if (startupChanged) {
				disposeStartup();
				currentConfig = nextConfig;
				installStartupFeature();
			}
			statusLine?.configure(nextConfig);
			editor?.configure(nextConfig);
			startup?.configure(nextConfig);
		},
		invalidateGit() {
			if (disposed || !host.cwd || !currentConfig.enabled || !currentConfig.statusLine.enabled) return;
			git.invalidate(host.cwd);
			void git.get(host.cwd).then((value) => {
				if (disposed) return;
				currentSnapshot = replaceSnapshot(currentSnapshot, generation, { ...currentSnapshot, git: value });
				statusLine?.update(currentSnapshot);
				editor?.update(currentSnapshot);
				startup?.update({
					...currentSnapshot,
					reason: host.startupReason ?? "startup",
					...(host.provider ? { startupProvider: host.provider } : {}),
					...(host.cwd ? { project: host.cwd.split(/[\\/]/).filter(Boolean).at(-1) } : {}),
					preset: currentConfig.preset,
				});
				requestRender();
			});
		},
		get disposed() {
			return disposed;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			scheduler.cancel();
			// UI surfaces are restored synchronously so teardown is deterministic;
			// the store then disposes the (already disposed) feature instances idempotently.
			disposeStatus();
			disposeEditor();
			disposeStartup();
			git.dispose();
			contextProvider.clear();
			usageProvider.reset();
			void disposables.dispose();
		},
	};
}

export class PiOmpThemeRuntimeController {
	private activeRuntime: PiOmpThemeRuntime | undefined;
	private nextGeneration = 0;

	start(ctx: RuntimeHost): PiOmpThemeRuntime {
		this.stop();
		this.activeRuntime = createPiOmpThemeRuntime(ctx, ++this.nextGeneration);
		return this.activeRuntime;
	}

	stop(): void {
		this.activeRuntime?.dispose();
		this.activeRuntime = undefined;
	}

	get current(): PiOmpThemeRuntime | undefined {
		return this.activeRuntime;
	}
}

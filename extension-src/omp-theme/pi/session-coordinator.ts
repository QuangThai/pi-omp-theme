import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import type { ConfigFilePort } from "../app/config-storage.js";
import { createPiOmpThemeApp, type PiOmpThemeApp } from "../app/index.js";
import { resolveTheme } from "../domain/theme.js";
import { setSpecialBlockTheme } from "../features/messages/special-blocks.js";
import { setBoxChrome, setBoxTheme } from "../shared/box.js";
import { WELCOME_SESSION_SLOTS } from "../features/startup/welcome.js";
import { readRecentSessions } from "./recent-sessions.js";
import { setBashExecutionTheme } from "../features/tools/bash-execution.js";
import { resetBashTreeRegistry } from "../features/tools/boxed/bash.js";
import { resetBatchRegistry } from "../features/tools/boxed/batch.js";
import { resetGrepRegistry } from "../features/tools/boxed/grep.js";
import {
	setToolsRenderConfig,
	stopAllElapsedTickers,
	type ToolsRenderConfig,
} from "../features/tools/boxed/session-config.js";
import { rebuildTurnRegistryFromEntries, resetTurnRegistry } from "../features/tools/boxed/turn-summary.js";
import {
	configureWorkingShimmer,
	installWorkingIndicator,
	restoreWorkingIndicator,
} from "../features/working-indicator/index.js";
import { createCompatibilityCoordinator } from "./compatibility-coordinator.js";
import {
	type CompatibilityCleanupResult,
	type CompatibilityProbeReport,
	disposePiCompatibilityProbe,
} from "./compatibility-probe.js";
import { createPiConfigFilePort, defaultStoragePaths } from "./config-host.js";
import { createConfigSourceAdapter, readSessionAuthorization } from "./config-session.js";
import { describeForeignHostBinding, type HostBinding, probeHostBinding } from "./host-binding.js";
import { buildOperationalState } from "./operational-state.js";
import { collectToolDetails } from "./startup-resources.js";

export type CompatibilityTestHooks = {
	dispose?: (report: CompatibilityProbeReport) => CompatibilityCleanupResult;
	filePort?: ConfigFilePort;
	paths?: (cwd: string) => { globalPath: string; projectPath: string };
	/** Test-only capability seam; Pi's ExtensionContext does not provide a Git runner. */
	gitRunner?: import("../domain/providers.js").GitCommandRunner;
	/** Override the thinking-cycle key binding consumed to suppress Pi's status toast. */
	thinkingCycleKey?: string;
};

const THINKING_CYCLE = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function createPiOmpThemeSessionCoordinator(pi: ExtensionAPI, hooks: CompatibilityTestHooks = {}) {
	const filePort = hooks.filePort ?? createPiConfigFilePort();
	const gitRunner =
		hooks.gitRunner ??
		({
			run: async (args, commandCwd, timeoutMs, signal) => {
				const result = await pi.exec("git", [...args], {
					cwd: commandCwd,
					timeout: timeoutMs,
					...(signal ? { signal } : {}),
				});
				return { stdout: result.stdout, stderr: result.stderr, code: result.code };
			},
		} satisfies import("../domain/providers.js").GitCommandRunner);
	let cwd = process.cwd();
	let active = false;
	let tuiSession = false;
	let terminalInputUnsubscribe: (() => void) | undefined;
	let sessionTheme: unknown;
	let sessionUi: import("@earendil-works/pi-coding-agent").ExtensionUIContext | undefined;
	const source = createConfigSourceAdapter(
		pi,
		filePort,
		hooks.paths ?? ((sessionCwd) => defaultStoragePaths(sessionCwd)),
	);
	const compatibility = createCompatibilityCoordinator(
		(report) => hooks.dispose?.(report) ?? disposePiCompatibilityProbe(report),
	);
	// Initial read may be empty in real Pi (flag values apply after extension load);
	// start() re-reads and re-captures at every session_start.
	let authorization = readSessionAuthorization(pi);
	let productGate: "omitted" | "allow" | "deny" = "omitted";
	// Probed once per process at the first session start: whether this module
	// graph is the running Pi's own (see host-binding.ts). A "foreign" binding
	// withholds every core patch and is reported once in the session.
	let hostBinding: HostBinding | undefined;
	let hostBindingProbe: Promise<HostBinding> | undefined;
	let foreignBindingReported = false;
	const syncOperational = (config: import("../domain/config-types.js").NormalizedPiOmpThemeConfig) => {
		app.setOperationalState(
			buildOperationalState(
				config,
				authorization,
				compatibility,
				app.runtime.current?.installationState,
				app.productPolicy.corePatchGate,
			),
		);
	};
	/** Render-scoped tool config: line budgets + the resolved open-tree glyph. */
	const applyToolsRenderConfig = (config: import("../domain/config-types.js").NormalizedPiOmpThemeConfig) => {
		setBoxChrome(config.tools.chrome);
		setBoxTheme(sessionTheme as never);
		setToolsRenderConfig({
			...config.tools,
			batchOpenGlyph: resolveTheme(sessionTheme as never, config, process.env).glyph("batchOpen"),
			nerdFonts: resolveTheme(sessionTheme as never, config, process.env).mode === "nerd",
		} satisfies ToolsRenderConfig);
	};
	/**
	 * Hide Pi's "Thinking..." placeholder label: an empty label renders zero
	 * lines, so the thinking block leaves no trace while content stays hidden.
	 * Passing undefined restores the default label.
	 */
	const applyMessagesConfig = (config: import("../domain/config-types.js").NormalizedPiOmpThemeConfig) => {
		sessionUi?.setHiddenThinkingLabel?.(config.messages.hideThinkingLabel ? "" : undefined);
	};
	/**
	 * Auto-apply the configured pi-omp-theme theme (default "titanium") once per TUI
	 * session before any surface captures the active theme, so a fresh install
	 * renders with the intended palette. Failure-safe: an unresolvable target is
	 * never passed to Pi (its setTheme falls back to the dark theme on load
	 * error, which would clobber the user's theme), and "off" disables the
	 * surface for users who keep their own theme.
	 */
	const applyAutoTheme = (
		config: import("../domain/config-types.js").NormalizedPiOmpThemeConfig,
		ctx: ExtensionContext,
	) => {
		const target = config.theme.autoApply;
		if (ctx.mode !== "tui" || !target || target === "off") return;
		const ui = ctx.ui;
		if (ui?.theme?.name === target) return;
		// Resolve before switching (see failure-safe note above).
		if (!ui?.getTheme?.(target)) return;
		ui.setTheme?.(target);
	};
	const app: PiOmpThemeApp = createPiOmpThemeApp(
		undefined,
		{
			load: async (trusted) => {
				source.setSession(cwd, trusted);
				return source.load();
			},
		},
		(config) => {
			productGate = app.productPolicy.corePatchGate;
			if (!active) return;
			// Apply render-scoped tool config live so `/pi-omp-theme set tools.*` takes
			// effect immediately (line budgets, dimOutput, open-tree glyph, …).
			applyToolsRenderConfig(config);
			applyMessagesConfig(config);
			if (compatibility.report) {
				const cleanup = compatibility.dispose();
				if (!cleanup.complete) {
					syncOperational(config);
					return;
				}
			}
			compatibility.install(config, tuiSession, productGate, hostBinding);
			syncOperational(config);
		},
	);

	return {
		app,
		async start(event: { reason: string }, ctx: ExtensionContext): Promise<void> {
			// Authorization is session-bound: Pi applies extension flag values only after
			// extension modules finish loading, so flags must be read here (session_start),
			// never at coordinator creation time.
			authorization = readSessionAuthorization(pi);
			compatibility.captureAuthorization(
				authorization.core,
				authorization.assistant,
				authorization.specialBlocks,
				authorization.tools,
				authorization.ascii,
			);
			// Replacement is failure-atomic: retain the current runtime until
			// compatibility ownership has been restored successfully.
			if (compatibility.report) {
				const cleanup = compatibility.dispose();
				if (!cleanup.complete) {
					syncOperational(app.config);
					return;
				}
			}
			if (app.runtime.current) app.sessionShutdown();
			cwd = ctx.cwd ?? process.cwd();
			tuiSession = ctx.mode === "tui";
			app.setProjectTrusted(ctx.isProjectTrusted());
			source.setSession(cwd, ctx.isProjectTrusted());
			// Drop any batch state carried over from the previous session (Pi renders
			// the restored chat between session_shutdown and the next session_start).
			resetBatchRegistry();
			resetGrepRegistry();
			resetBashTreeRegistry();
			// Turn summaries (ADR 0007): rebuild the registry from session content so
			// restored/forked history renders collapsed before the first render pass
			// (deterministic; no in-process turn_end events needed).
			resetTurnRegistry();
			rebuildTurnRegistryFromEntries(ctx.sessionManager.getEntries());
			// Stop any 1s elapsed re-render ticker left by a tool that was still
			// running when the session ended.
			stopAllElapsedTickers();
			active = false;
			await app.reload();
			productGate = app.productPolicy.corePatchGate;
			// Resolve the host binding before the first install so a foreign module
			// graph never certifies patches against a Pi copy that does not render.
			hostBindingProbe ??= probeHostBinding();
			hostBinding = await hostBindingProbe;
			if (hostBinding.status === "foreign" && !foreignBindingReported) {
				foreignBindingReported = true;
				ctx.ui?.notify?.(describeForeignHostBinding(hostBinding), "warning");
			}
			active = true;
			compatibility.install(app.config, ctx.mode === "tui", productGate, hostBinding);
			// Auto-apply the configured theme before surfaces capture the active one.
			applyAutoTheme(app.config, ctx);
			// Session-scoped render configuration for the boxed tool/message surfaces.
			// Populated once per session (never inside render).
			sessionTheme = ctx.ui?.theme as never;
			sessionUi = ctx.ui as import("@earendil-works/pi-coding-agent").ExtensionUIContext | undefined;
			applyToolsRenderConfig(app.config);
			applyMessagesConfig(app.config);
			if (ctx.ui?.theme) setSpecialBlockTheme(ctx.ui.theme as never);
			if (ctx.ui?.theme) setBashExecutionTheme(ctx.ui.theme as never);
			if (app.config.enabled) {
				// Re-resolved on each call rather than captured here: Pi may not have put
				// a theme on the UI context yet at session start, and a palette taken
				// then comes back empty and stays empty for the whole session — the
				// working row renders bold but colourless. The shimmer asks per run.
				const resolveWorkingTheme = () => {
					const piTheme = ctx.ui?.theme as { fg?: (color: string, text: string) => string } | undefined;
					return resolveTheme(
						piTheme?.fg ? { fg: (color: string, text: string) => piTheme.fg?.(color, text) ?? text } : undefined,
						app.config,
					);
				};
				installWorkingIndicator(ctx.ui, resolveWorkingTheme().mode === "ascii");
				configureWorkingShimmer(ctx.ui, app.config.theme.shimmer, () => {
					const resolved = resolveWorkingTheme();
					return {
						low: resolved.color("dim"),
						mid: resolved.color("muted"),
						high: resolved.color("accent"),
						bold: true,
					};
				});
			} else restoreWorkingIndicator(ctx.ui);
			const toolDetails = collectToolDetails(pi.getActiveTools?.(), pi.getAllTools?.());
			// Pi exposes only the live session, so the welcome card's recent list is
			// read from the directory Pi writes sessions into. Best-effort by design:
			// it returns an empty list rather than delaying or failing startup.
			const sessions = readRecentSessions(ctx.sessionManager?.getSessionFile?.(), WELCOME_SESSION_SLOTS);
			let sessionTitle: string | undefined;
			try {
				sessionTitle = ctx.sessionManager?.getSessionName?.() || undefined;
			} catch {
				sessionTitle = undefined;
			}
			app.sessionStart(
				{
					mode: ctx.mode,
					hasUI: ctx.hasUI,
					...(ctx.ui ? { ui: ctx.ui } : {}),
					...(ctx.cwd ? { cwd: ctx.cwd } : {}),
					...(ctx.model
						? {
								model: {
									id: ctx.model.id,
									name: ctx.model.name,
									provider: ctx.model.provider,
									reasoning: ctx.model.reasoning,
								},
							}
						: {}),
					...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
					// Seeded here as well as from session_info_changed: that event fires
					// only when the name changes, so a resumed session would show an
					// untitled bar until something renamed it.
					...(sessionTitle ? { sessionName: sessionTitle } : {}),
					getContextUsage: ctx.getContextUsage,
					projectTrusted: ctx.isProjectTrusted(),
					gitRunner,
				},
				event.reason as "startup" | "reload" | "new" | "resume" | "fork",
				{
					...(typeof ctx.getSystemPrompt === "function" ? { systemPrompt: ctx.getSystemPrompt() } : {}),
					...(toolDetails ? { toolDetails } : {}),
					...(sessions.length > 0 ? { sessions } : {}),
					...(ctx.scopedModels && ctx.scopedModels.length > 0 ? { models: ctx.scopedModels.length } : {}),
				},
			);
			terminalInputUnsubscribe?.();
			terminalInputUnsubscribe = undefined;
			// Consume Pi's default thinking-cycle key and re-issue it through the public API so
			// the footer shows the level without Pi's transient "Thinking level: X" status toast.
			const cycleKey = hooks.thinkingCycleKey ?? "shift+tab";
			if (ctx.mode === "tui" && ctx.ui?.onTerminalInput) {
				terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
					if (!matchesKey(data, cycleKey as KeyId)) return undefined;
					const current = pi.getThinkingLevel?.();
					const index = Math.max(0, THINKING_CYCLE.indexOf(current as (typeof THINKING_CYCLE)[number]));
					const next = THINKING_CYCLE[(index + 1) % THINKING_CYCLE.length];
					pi.setThinkingLevel?.(next as never);
					return { consume: true };
				});
			}
			syncOperational(app.config);
		},
		shutdown(): void {
			active = false;
			tuiSession = false;
			terminalInputUnsubscribe?.();
			terminalInputUnsubscribe = undefined;
			resetBatchRegistry();
			resetGrepRegistry();
			resetBashTreeRegistry();
			resetTurnRegistry();
			stopAllElapsedTickers();
			app.sessionShutdown();
			// Tier C prototype patches stay installed across session switches. Pi renders
			// the restored chat (renderBeforeBind) AFTER session_shutdown but BEFORE the
			// next session_start, so disposing here would rebuild the resumed tool and
			// special-block surfaces with native prototypes and they would never be
			// re-decorated (their boxed output is derived once at updateDisplay time and
			// cached; a later frame render does not re-invoke the renderer selectors).
			// The next start() disposes this report (restoring the native identities)
			// and reinstalls before any new render. On process exit (reason "quit") the
			// terminal is torn down immediately after, so retained patches are harmless.
		},
	};
}

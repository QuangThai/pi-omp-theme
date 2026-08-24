import { isTierCAuthorized } from "../domain/config-authorization.js";
import type { NormalizedPiOmpThemeConfig } from "../domain/config-types.js";
import {
	type CompatibilityCleanupResult,
	type CompatibilityProbeReport,
	detectPiVersion,
	disposePiCompatibilityProbe,
	probePiCompatibility,
	COMPATIBILITY_BASIS,
} from "./compatibility-probe.js";
import type { HostBinding } from "./host-binding.js";

export interface CompatibilityCoordinator {
	captureAuthorization(
		coreFlag: boolean,
		assistantFlag: boolean,
		specialBlocksFlag: boolean,
		toolsFlag: boolean,
		asciiFlag: boolean,
	): void;
	state(config: NormalizedPiOmpThemeConfig): Readonly<Record<string, unknown>>;
	/**
	 * Install the certified patches. A "foreign" host binding (the extension
	 * imported a second copy of Pi, see host-binding.ts) skips installation: the
	 * patches would certify and install fine on that copy and never run.
	 */
	install(
		config: NormalizedPiOmpThemeConfig,
		tui: boolean,
		productGate?: "omitted" | "allow" | "deny",
		hostBinding?: HostBinding,
	): CompatibilityProbeReport | undefined;
	dispose(): CompatibilityCleanupResult;
	readonly report: CompatibilityProbeReport | undefined;
}

export function createCompatibilityCoordinator(dispose = disposePiCompatibilityProbe): CompatibilityCoordinator {
	let report: CompatibilityProbeReport | undefined;
	let cleanupPending = false;
	let authorization:
		| {
				core: boolean;
				assistant: boolean;
				specialBlocks: boolean;
				tools: boolean;
				ascii: boolean;
		  }
		| undefined;
	let hostBinding: HostBinding | undefined;
	return {
		get report() {
			return report;
		},
		captureAuthorization(core, assistant, specialBlocks, tools, ascii) {
			authorization = { core, assistant, specialBlocks, tools, ascii };
		},
		state(config) {
			const version = detectPiVersion();
			const messagesConfigured =
				config.enabled && config.messages.enabled && (config.messages.assistantPrefix || config.messages.specialBlocks);
			const toolsConfigured = config.enabled && config.tools.enabled;
			const surface = (
				feature: "messages" | "tools",
				configured: boolean,
				surfaceAuthorized: boolean,
				subtype?: string,
			) => {
				const records =
					report?.unsupported.filter((item) =>
						feature === "messages" ? item.subtype.includes("message") : item.subtype.includes("tool"),
					) ?? [];
				// Identity drift degrades only the affected surface to native (graceful);
				// a feature is only "failed" when an install/shape error occurred.
				const failed = records.some((item) => /failed|rejected|rolled back|shape is not/i.test(item.reason));
				const fallback = records.some((item) => /fallback|authorization|disabled|identity/i.test(item.reason));
				const authorized = Boolean(authorization?.core && surfaceAuthorized);
				const installedRecord = report?.recordSnapshots.some(
					(item) => item.feature === feature && !item.disposed && (subtype === undefined || item.subtype === subtype),
				);
				return {
					configured,
					authorized,
					installed: Boolean(installedRecord && authorized && configured),
					conflicted: records.some((item) => item.reason.includes("owner")),
					failed,
					cleanupPending,
					nativeFallback: fallback,
					...(authorized ? {} : { awaitingAuthorization: true }),
				};
			};
			return {
				configured: messagesConfigured || toolsConfigured,
				authorized: authorization?.core ?? false,
				installed: report !== undefined,
				conflicted: report?.unsupported.some((item) => item.reason.includes("owner")) ?? false,
				failed: report?.unsupported.some((item) => /failed|rejected|rolled back/i.test(item.reason)) ?? false,
				cleanupPending,
				nativeFallbacks: report?.unsupported.filter((item) => /fallback|identity/i.test(item.reason)).length ?? 0,
				piVersion: version.version ?? report?.piVersion ?? "unknown",
				compatibilityBasis: report?.compatibilityBasis ?? COMPATIBILITY_BASIS,
				// Whether this extension shares the running Pi's modules. "foreign" means
				// every core patch is withheld: it would certify against a second copy of
				// Pi that never renders (see host-binding.ts).
				hostBinding: hostBinding ?? { status: "unknown", reason: "not probed yet" },
				assistantMessage: surface(
					"messages",
					config.enabled && config.messages.enabled && config.messages.assistantPrefix,
					Boolean(authorization?.assistant),
					"native-assistant-message",
				),
				tools: surface("tools", config.enabled && config.tools.enabled, Boolean(authorization?.tools)),
				specialBlocks: surface(
					"messages",
					config.enabled && config.messages.enabled && config.messages.specialBlocks,
					Boolean(authorization?.core),
				),
			};
		},
		install(config, tui, productGate = "omitted", binding) {
			hostBinding = binding ?? hostBinding;
			const productDenied = productGate === "deny";
			if (cleanupPending && !report) cleanupPending = false;
			if (cleanupPending || !tui || !config.enabled || !authorization?.core || productDenied) return undefined;
			if (hostBinding?.status === "foreign") return undefined;
			// Certification is per-surface identity based, never pinned to a Pi version:
			// authorization only needs the session flags + config. Version drift that
			// preserves the recorded identity keeps working; changed identities degrade
			// per-surface inside the probe.
			const assistantEnabled =
				authorization.assistant &&
				isTierCAuthorized({
					coreFlag: authorization.core,
					surfaceFlag: true,
					surface: "assistantMessage",
					config,
				});
			const specialBlocksEnabled =
				authorization.specialBlocks &&
				isTierCAuthorized({
					coreFlag: authorization.core,
					surfaceFlag: true,
					surface: "specialBlocks",
					config,
				});
			const messagesEnabled = (assistantEnabled || specialBlocksEnabled) && config.messages.enabled;
			// The hidden-thinking collapse is an assistant-message surface patch: it needs
			// the assistant flag and `messages.hideThinkingLabel`, independent of the
			// assistant prefix feature.
			const thinkingCollapseEnabled = Boolean(
				authorization.assistant &&
					config.messages.enabled &&
					config.messages.hideThinkingLabel &&
					isTierCAuthorized({
						coreFlag: authorization.core,
						surfaceFlag: true,
						surface: "messages",
						config,
					}),
			);
			const toolsEnabled =
				authorization.tools &&
				isTierCAuthorized({ coreFlag: authorization.core, surfaceFlag: true, surface: "tools", config });
			if (!messagesEnabled && !toolsEnabled) return undefined;
			const detected = detectPiVersion();
			report = probePiCompatibility(detected.version, {
				config: {
					...config,
					messages: {
						...config.messages,
						enabled: messagesEnabled,
						assistantPrefix: assistantEnabled,
						hideThinkingLabel: thinkingCollapseEnabled,
						specialBlocks: messagesEnabled && config.messages.specialBlocks && specialBlocksEnabled,
					},
					tools: {
						...config.tools,
						enabled: toolsEnabled,
					},
				},
				messageSnapshot: {
					assistantPrefix: authorization.ascii ? "[assistant] " : "│ ",
					assistantEnabled,
					collapseHiddenThinking: thinkingCollapseEnabled,
					hideInterimText: config.messages.hideInterimText && messagesEnabled,
				},
				toolSnapshot: {
					callMarker: authorization.ascii ? "[tool] " : "[tool] ",
					resultMarker: authorization.ascii ? "[result] " : "[tool:result] ",
					style: config.tools.style === "compact-box" ? "compact-box" : "marker",
				},
			});
			return report;
		},
		dispose() {
			if (!report) {
				cleanupPending = false;
				return { complete: true, retryablePrototypeRecords: 0, retryableToolRecords: 0 };
			}
			const result = dispose(report);
			cleanupPending = !result.complete;
			if (result.complete) {
				report = undefined;
				cleanupPending = false;
			}
			return result;
		},
	};
}

import type { ConfigDiagnostic } from "../domain/config-diagnostics.js";
import type { NormalizedPiOmpThemeConfig } from "../domain/config-types.js";

export interface DoctorOperationalState {
	readonly compatibility?: Readonly<Record<string, unknown>>;
	readonly provider?: Readonly<Record<string, unknown>>;
	readonly installations?: Readonly<Record<string, unknown>>;
	readonly authorization?: Readonly<Record<string, unknown>>;
}

export interface DoctorState {
	readonly config: NormalizedPiOmpThemeConfig;
	readonly diagnostics: readonly ConfigDiagnostic[];
	readonly sources?: Readonly<Record<string, string>>;
	readonly surfaces: Readonly<Record<string, unknown>>;
	readonly piVersion?: string;
	readonly compatibility?: string;
	readonly operational?: DoctorOperationalState;
}

export function createDoctor(state: DoctorState): Readonly<Record<string, unknown>> {
	return Object.freeze({
		config: Object.freeze({
			preset: state.config.preset,
			enabled: state.config.enabled,
			placement: state.config.placement,
			statusLine: state.config.statusLine.enabled ? "enabled" : "disabled",
			editor: state.config.editor.enabled ? "enabled" : "disabled",
			startup: state.config.startup.mode,
		}),
		diagnostics: state.diagnostics,
		sources: state.sources ?? {},
		surfaces: state.surfaces,
		...(state.piVersion ? { piVersion: state.piVersion } : {}),
		...(state.operational?.compatibility && typeof state.operational.compatibility.piVersion === "string"
			? { piVersion: state.operational.compatibility.piVersion }
			: {}),
		...(state.operational?.compatibility && typeof state.operational.compatibility.versionRange === "string"
			? { piVersionRange: state.operational.compatibility.versionRange }
			: {}),
		...(state.compatibility ? { compatibility: state.compatibility } : {}),
		...(state.operational
			? {
					operational: Object.freeze({
						...(state.operational.compatibility ? { compatibility: state.operational.compatibility } : {}),
						...(state.operational.provider ? { provider: state.operational.provider } : {}),
						...(state.operational.installations ? { installations: state.operational.installations } : {}),
						...(state.operational.authorization ? { authorization: state.operational.authorization } : {}),
					}),
				}
			: {}),
	});
}

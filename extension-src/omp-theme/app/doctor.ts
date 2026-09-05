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
		...(state.operational?.compatibility && typeof state.operational.compatibility.compatibilityBasis === "string"
			? { compatibilityBasis: state.operational.compatibility.compatibilityBasis }
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

type DoctorRecord = Readonly<Record<string, unknown>>;
type DoctorNoticeType = "info" | "warning" | "error";
type DoctorSeverity = 0 | 1 | 2;

interface SurfaceSummary {
	readonly label: string;
	readonly state: string;
	readonly detail: string;
	readonly severity: DoctorSeverity;
}

export interface DoctorSummary {
	readonly message: string;
	readonly type: DoctorNoticeType;
}

const SURFACE_LABELS = [
	["status", "Status line"],
	["editor", "Editor"],
	["startup", "Startup"],
	["assistantMessage", "Assistant message"],
	["specialBlocks", "Special blocks"],
	["tools", "Tools"],
] as const;

function asRecord(value: unknown): DoctorRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as DoctorRecord)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function surfaceSummary(label: string, value: unknown): SurfaceSummary {
	if (typeof value === "string") {
		if (["installed", "active", "enabled"].includes(value)) return { label, state: "OK", detail: value, severity: 0 };
		if (["disabled", "off"].includes(value)) return { label, state: "OFF", detail: "disabled", severity: 0 };
		if (["failed", "error"].includes(value)) return { label, state: "ERROR", detail: value, severity: 2 };
		return { label, state: "CHECK", detail: value, severity: 1 };
	}

	const state = asRecord(value);
	if (state?.configured === false) return { label, state: "OFF", detail: "disabled by configuration", severity: 0 };
	if (state?.failed === true) return { label, state: "ERROR", detail: "patch installation failed", severity: 2 };
	if (state?.conflicted === true) return { label, state: "CONFLICT", detail: "existing renderer kept", severity: 1 };
	if (state?.authorized === false) return { label, state: "LOCKED", detail: "authorization required", severity: 1 };
	if (state?.nativeFallback === true) return { label, state: "NATIVE", detail: "using Pi renderer (fallback)", severity: 1 };
	if (state?.cleanupPending === true) return { label, state: "PENDING", detail: "cleanup pending", severity: 1 };
	if (state?.installed === true) return { label, state: "OK", detail: "installed", severity: 0 };
	return { label, state: "CHECK", detail: "not installed", severity: 1 };
}

function compactPath(path: string): string {
	return path
		.replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\)/, "~")
		.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~");
}

/** Human-first doctor output; the complete payload remains available as JSON. */
export function formatDoctorSummary(report: DoctorRecord): DoctorSummary {
	const config = asRecord(report.config) ?? {};
	const surfaces = asRecord(report.surfaces) ?? {};
	const operational = asRecord(report.operational);
	const compatibility = asRecord(operational?.compatibility);
	const binding = asRecord(compatibility?.hostBinding);
	const authorization = asRecord(operational?.authorization);
	const diagnostics = Array.isArray(report.diagnostics)
		? report.diagnostics.map(asRecord).filter((item): item is DoctorRecord => item !== undefined)
		: [];
	const surfaceRows = SURFACE_LABELS.filter(([key]) => key in surfaces).map(([key, label]) =>
		surfaceSummary(label, surfaces[key]),
	);

	const diagnosticSeverity: DoctorSeverity = diagnostics.some((item) => item.level === "error")
		? 2
		: diagnostics.length > 0
			? 1
			: 0;
	const bindingStatus = text(binding?.status);
	const bindingSeverity: DoctorSeverity = bindingStatus && bindingStatus !== "bound" ? 1 : 0;
	const coreAuthorized = authorization?.core;
	const authorizationSeverity: DoctorSeverity = coreAuthorized === false ? 1 : 0;
	const severity = Math.max(
		diagnosticSeverity,
		bindingSeverity,
		authorizationSeverity,
		...surfaceRows.map((row) => row.severity),
	) as DoctorSeverity;
	const enabled = config.enabled !== false;
	const overall = severity === 2 ? "ERROR" : !enabled ? "OFF" : severity === 1 ? "DEGRADED" : "HEALTHY";
	const type: DoctorNoticeType = severity === 2 ? "error" : severity === 1 ? "warning" : "info";
	const piVersion = text(report.piVersion) ?? text(compatibility?.piVersion) ?? "unknown";
	const basis = text(report.compatibilityBasis) ?? text(compatibility?.compatibilityBasis) ?? "unknown";

	const lines = [
		`pi-omp-theme doctor · ${overall}`,
		"",
		"Runtime",
		`  ${"Pi".padEnd(16)}${piVersion}`,
		`  ${"Preset".padEnd(16)}${text(config.preset) ?? "unknown"}`,
		`  ${"Placement".padEnd(16)}${text(config.placement) ?? "unknown"}`,
		`  ${"Compatibility".padEnd(16)}${basis}`,
		`  ${"Host binding".padEnd(16)}${bindingStatus ?? "unknown"}`,
		`  ${"Core patches".padEnd(16)}${coreAuthorized === true ? "authorized" : coreAuthorized === false ? "not authorized" : "unknown"}`,
		"",
		"Surfaces",
		...(surfaceRows.length > 0
			? surfaceRows.map((row) => `  ${row.state.padEnd(10)}${row.label.padEnd(20)}${row.detail}`)
			: ["  CHECK     No surface data"]),
	];

	if (diagnostics.length > 0) {
		lines.push("", `Diagnostics (${diagnostics.length})`);
		for (const diagnostic of diagnostics) {
			const level = text(diagnostic.level)?.toUpperCase() ?? "CHECK";
			lines.push(`  ${level.padEnd(10)}${text(diagnostic.code) ?? "unknown"}`);
			if (text(diagnostic.message)) lines.push(`    ${text(diagnostic.message)}`);
			if (text(diagnostic.path)) lines.push(`    at ${compactPath(text(diagnostic.path)!)}`);
		}
	}

	lines.push("", "Full report", "  /pi-omp-theme doctor json");
	return Object.freeze({ message: lines.join("\n"), type });
}

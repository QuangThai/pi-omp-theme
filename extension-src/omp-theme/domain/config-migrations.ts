import { boundedDiagnostics, type ConfigDiagnostic } from "./config-diagnostics.js";
import { PI_OMP_THEME_SCHEMA_VERSION } from "./config-types.js";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface MigrationResult {
	readonly config: Record<string, unknown> | undefined;
	readonly diagnostics: readonly ConfigDiagnostic[];
	readonly readOnly: boolean;
}

/** Purely validates the durable envelope; v1 is identity and future data is read-only. */
export function migrateConfig(input: unknown, source = "config"): MigrationResult {
	if (!record(input))
		return {
			config: undefined,
			readOnly: false,
			diagnostics: boundedDiagnostics([
				{ code: "CFG-001", level: "warning", path: source, message: "configuration must be an object; defaults used" },
			]),
		};
	const version = input.schemaVersion;
	if (version === undefined)
		return {
			config: { ...input, schemaVersion: PI_OMP_THEME_SCHEMA_VERSION },
			readOnly: false,
			diagnostics: boundedDiagnostics([
				{
					code: "CFG-002",
					level: "warning",
					path: `${source}.schemaVersion`,
					message: "missing schemaVersion accepted as v1-shaped input",
				},
			]),
		};
	if (version !== PI_OMP_THEME_SCHEMA_VERSION)
		return {
			config: undefined,
			readOnly: true,
			diagnostics: boundedDiagnostics([
				{
					code: "CFG-003",
					level: "error",
					path: `${source}.schemaVersion`,
					message: `unsupported schemaVersion ${String(version)}; ignored without rewrite`,
				},
			]),
		};
	return { config: { ...input }, readOnly: false, diagnostics: [] };
}

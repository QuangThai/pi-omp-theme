import type { ConfigDiagnostic } from "../domain/config-diagnostics.js";
import { migrateConfig } from "../domain/config-migrations.js";

export interface ConfigStoragePaths {
	readonly globalPath: string;
	readonly projectPath: string;
}
export interface ConfigFilePort {
	read(path: string): Promise<string>;
	writeAtomic(path: string, content: string): Promise<void>;
}
export interface ConfigRead {
	readonly value: unknown;
	readonly diagnostics: readonly ConfigDiagnostic[];
	readonly readOnly: boolean;
}

export async function readScopedConfig(
	port: ConfigFilePort,
	path: string,
	selectedNamespace = "piOmpTheme",
): Promise<ConfigRead> {
	try {
		const parsed = JSON.parse(await port.read(path)) as unknown;
		if (!record(parsed))
			return {
				value: undefined,
				readOnly: true,
				diagnostics: [{ code: "CFG-001", level: "warning", path, message: "settings root must be an object" }],
			};
		if (!Object.hasOwn(parsed, selectedNamespace)) return { value: undefined, readOnly: false, diagnostics: [] };
		const result = migrateConfig(parsed[selectedNamespace], `${path}.${selectedNamespace}`);
		return { value: result.config, diagnostics: result.diagnostics, readOnly: result.readOnly };
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return { value: undefined, readOnly: false, diagnostics: [] };
		return {
			value: undefined,
			readOnly: true,
			diagnostics: [
				{
					code: "CFG-IO",
					level: "warning",
					path,
					message: `settings unreadable; preserved without rewrite (${error instanceof Error ? error.message : "invalid JSON"})`,
				},
			],
		};
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergePatch(base: unknown, patch: unknown): unknown {
	if (!record(base) || !record(patch)) return patch;
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) result[key] = mergePatch(result[key], value);
	return result;
}

const writeLocks = new Map<string, Promise<void>>();

export async function writeScopedConfig(
	port: ConfigFilePort,
	path: string,
	value: unknown,
	selectedNamespace = "piOmpTheme",
): Promise<void> {
	const previous = writeLocks.get(path) ?? Promise.resolve();
	const operation = previous.then(async () => {
		let document: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(await port.read(path)) as unknown;
			if (!record(parsed)) throw new Error("settings root must be an object");
			document = parsed;
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
			if (code !== "ENOENT") throw new Error(`refusing to rewrite unreadable settings: ${path}`);
		}
		if (Object.hasOwn(document, selectedNamespace)) {
			const existing = migrateConfig(document[selectedNamespace], `${path}.${selectedNamespace}`);
			if (existing.readOnly || !record(document[selectedNamespace]))
				throw new Error(`refusing to rewrite protected ${selectedNamespace} namespace: ${path}`);
		}
		const nextNamespace = mergePatch(document[selectedNamespace], value);
		await port.writeAtomic(path, `${JSON.stringify({ ...document, [selectedNamespace]: nextNamespace }, null, 2)}\n`);
	});
	writeLocks.set(path, operation);
	try {
		await operation;
	} finally {
		if (writeLocks.get(path) === operation) writeLocks.delete(path);
	}
}

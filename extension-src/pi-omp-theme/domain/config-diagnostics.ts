export type ConfigDiagnosticLevel = "warning" | "error";
export interface ConfigDiagnostic {
	readonly code: string;
	readonly level: ConfigDiagnosticLevel;
	readonly path: string;
	readonly message: string;
}

export function boundedDiagnostics(items: readonly ConfigDiagnostic[], limit = 32): readonly ConfigDiagnostic[] {
	const seen = new Set<string>();
	const result: ConfigDiagnostic[] = [];
	for (const item of items) {
		const key = `${item.level}:${item.code}:${item.path}:${item.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(Object.freeze(item));
		if (result.length >= limit) break;
	}
	return Object.freeze(result);
}

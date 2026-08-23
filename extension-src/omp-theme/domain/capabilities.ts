export type DiagnosticClass = "capability" | "configuration" | "conflict" | "fallback" | "error";
export interface CapabilityRecord {
	readonly name: string;
	readonly available: boolean;
	readonly tier: "A" | "B" | "C";
	readonly detail?: string;
}
export interface DiagnosticRecord {
	readonly classification: DiagnosticClass;
	readonly code: string;
	readonly message: string;
	readonly secretFree: true;
}
export interface CapabilityHost {
	ui?: Record<string, unknown>;
	mode?: string;
	hasUI?: boolean;
}
export function detectCapabilities(host: CapabilityHost): readonly CapabilityRecord[] {
	const ui = host.ui ?? {};
	return Object.freeze(
		["setWidget", "setHeader", "setEditorComponent", "setFooter", "setWorkingIndicator"].map((name) =>
			Object.freeze({ name, available: typeof ui[name] === "function", tier: "A" as const }),
		),
	);
}
export function diagnostic(classification: DiagnosticClass, code: string, message: string): DiagnosticRecord {
	return Object.freeze({
		classification,
		code,
		message: message.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]"),
		secretFree: true,
	});
}

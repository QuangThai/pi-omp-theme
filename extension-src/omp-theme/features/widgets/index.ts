// Extension widget filter (`widgets.hide`).
//
// Extensions place widgets around the editor through `ctx.ui.setWidget(key, …)`,
// which Pi routes to `InteractiveMode.setExtensionWidget`. A hidden key keeps its
// slot empty: the extension keeps running and keeps its own state, only the
// widget never reaches the screen. Clearing a hidden key still goes through, so
// a widget registered before the filter was installed can be removed.

type NativeSetWidget = (key: unknown, content: unknown, options?: unknown) => unknown;

/** Delegate for the patched `setExtensionWidget`. */
export function filterExtensionWidget(
	original: unknown,
	target: unknown,
	args: unknown[],
	hidden: ReadonlySet<string>,
): unknown {
	const [key, content] = args;
	if (typeof key === "string" && content !== undefined && hidden.has(key)) {
		return Reflect.apply(original as NativeSetWidget, target, [key, undefined]);
	}
	return Reflect.apply(original as NativeSetWidget, target, args);
}

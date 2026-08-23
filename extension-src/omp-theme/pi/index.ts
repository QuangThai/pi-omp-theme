import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StatusSnapshot } from "../domain/status.js";
import { closeActiveBatch } from "../features/tools/boxed/batch.js";
import {
	beginAgentRun,
	finishAgentRun,
	invalidateTurnMembers,
	rebuildTurnRegistryFromEntries,
	registerTurnFromMessage,
} from "../features/tools/boxed/turn-summary.js";
import { requestToolPresentationRender } from "../features/tools/index.js";
import {
	disposeWorkingShimmer,
	startWorkingShimmer,
	stopWorkingShimmer,
} from "../features/working-indicator/index.js";
import { registerPiOmpThemeCommand } from "./commands.js";
import { type CompatibilityTestHooks, createPiOmpThemeSessionCoordinator } from "./session-coordinator.js";
import { usageFromSession } from "./session-usage.js";

/** Usage patch that omits the key when no session usage exists (exact optional types). */
function usagePatch(ctx: ExtensionContext): StatusSnapshot {
	const usage = usageFromSession(ctx.sessionManager);
	return usage ? { usage } : {};
}

/**
 * Add Pi's read-only tools (grep/find/ls) to the active tool set if they are
 * registered. Preserves any other active tools (e.g. extension tools).
 * Only calls setActiveTools when something actually changed.
 */
function activateReadOnlyTools(pi: ExtensionAPI): void {
	const available = new Set(pi.getAllTools().map((tool) => tool.name));
	const active = new Set(pi.getActiveTools());
	let changed = false;
	for (const name of ["grep", "find", "ls"] as const) {
		if (available.has(name) && !active.has(name)) {
			active.add(name);
			changed = true;
		}
	}
	if (changed) pi.setActiveTools([...active]);
}

let compatibilityTestHooks: CompatibilityTestHooks = {};
export function __setCompatibilityTestHooks(hooks: CompatibilityTestHooks): () => void {
	const previous = compatibilityTestHooks;
	compatibilityTestHooks = hooks;
	return () => {
		compatibilityTestHooks = previous;
	};
}

/** Thin Pi adapter: register flags, commands, and forward lifecycle events. */
export default function piOmpThemeExtension(pi: ExtensionAPI): void {
	// The core/message/tool surfaces are default-on (identity-certified per surface by
	// name/arity/source fingerprint, graceful native fallback for any surface whose
	// runtime identity is not recorded, conflict-preserving). The OFF switch is the
	// product gate `compatibility.allowCorePatches: false` (or `enabled: false`) in config.
	for (const [name, description] of [
		["pi-omp-theme-core-patches", "Enable pi-omp-theme message/tool core patches"],
		["pi-omp-theme-message-assistant", "Enable pi-omp-theme assistant message prefix"],
		["pi-omp-theme-message-special-blocks", "Enable pi-omp-theme boxed compaction/skill/branch/custom message blocks"],
		["pi-omp-theme-tools", "Enable pi-omp-theme tool renderer decoration"],
		["pi-omp-theme-readonly-tools", "Enable grep/find/ls read-only tools in the active tool set"],
	] as const)
		pi.registerFlag(name, { type: "boolean", description, default: true });
	// ASCII markers stay opt-in; unicode markers are the default.
	pi.registerFlag("pi-omp-theme-ascii", { type: "boolean", description: "Use ASCII pi-omp-theme markers" });
	const coordinator = createPiOmpThemeSessionCoordinator(pi, compatibilityTestHooks);
	registerPiOmpThemeCommand(pi, coordinator.app);
	pi.on("session_start", async (event, ctx) => {
		// Pi only activates read/bash/edit/write by default; grep/find/ls are
		// registered but inactive (kept out of the model's tool list to keep the
		// core small). Activate them so the TUI shows them and the model can call
		// them directly, mirroring Claude Code's glob/grep/read tool set.
		if (pi.getFlag("pi-omp-theme-readonly-tools") === true) {
			activateReadOnlyTools(pi);
		}
		await coordinator.start(event, ctx);
	});
	pi.on("agent_start", () => {
		coordinator.app.runtime.current?.dismissStartup();
		startWorkingShimmer();
		// Turn summary (ADR 0007): a summary group spans the whole agent run
		// (user request → agent_end), not pi's per-message turn_end.
		beginAgentRun();
	});
	pi.on("input", (event, _ctx) => {
		coordinator.app.runtime.current?.dismissStartup();
		// Bare `!`/`!!` submit guard: Pi treats `!`-prefixed input as a direct bash
		// command but falls through to normal message submission when the bang has
		// no command after it — sending a literal `!` to the agent. Drop those
		// accidental submits instead; Pi's submit path already cleared the editor
		// (onChange("") resets isBashMode), so the input returns to the normal
		// prompt without sending anything. Only the interactive input box is
		// guarded; rpc/extension sources keep sending text verbatim.
		if (event.source === "interactive") {
			const trimmed = event.text.trimStart();
			if (trimmed.startsWith("!")) {
				const bangLength = trimmed.startsWith("!!") ? 2 : 1;
				if (trimmed.slice(bangLength).trim() === "") return { action: "handled" };
			}
		}
		return undefined;
	});
	pi.on("tool_execution_start", () => coordinator.app.runtime.current?.dismissStartup());
	pi.on("model_select", (event) =>
		coordinator.app.update(
			{
				model: event.model.name || event.model.id,
				...(event.model.provider ? { provider: event.model.provider } : {}),
				...(event.model.reasoning !== undefined ? { reasoning: event.model.reasoning } : {}),
			},
			"immediate",
		),
	);
	pi.on("thinking_level_select", (event) => coordinator.app.update({ thinkingLevel: event.level }, "immediate"));
	pi.on("session_info_changed", (event) => coordinator.app.update({ sessionName: event.name }, "coalesced"));
	pi.on("message_start", () => {
		// A new message is a batch boundary: quiet-tool (read/ls/find) calls of the
		// new message start a fresh batch instead of joining the previous one.
		closeActiveBatch();
		// grep/bash tree panels are NOT cleared here: historical panels must keep
		// their state so Pi re-renders of previous messages (scroll/resume) stay
		// intact. Only session boundaries reset them (session-coordinator).
	});
	pi.on("message_update", () => coordinator.app.update({}, "coalesced"));
	// Usage (tokens + cost) is aggregated from finalized session entries at
	// message/turn boundaries, mirroring Pi's native footer; per-chunk updates
	// stay usage-free to keep streaming cheap.
	pi.on("message_end", (_event, ctx) => coordinator.app.update({ ...usagePatch(ctx) }, "coalesced"));
	pi.on("turn_end", (event, ctx) => {
		// Append the finalized assistant message's tool batch to the current run.
		registerTurnFromMessage(event.message, event.toolResults);
		coordinator.app.update({ ...usagePatch(ctx) }, "deferred");
	});
	pi.on("agent_end", () => {
		stopWorkingShimmer();
		// The run is complete: collapse its tool blocks into one summary line.
		// Pi only re-invokes the tool renderer selectors from updateDisplay(), so
		// the captured per-block invalidate callbacks force the collapse and the
		// captured Tui repaints. Interrupted runs (a call without a result) stay
		// expanded.
		const run = finishAgentRun();
		if (run) {
			invalidateTurnMembers(run);
			requestToolPresentationRender();
		}
	});
	pi.on("agent_settled", (_event, ctx) => coordinator.app.update({ ...usagePatch(ctx) }, "coalesced"));
	pi.on("session_tree", (_event, ctx) => {
		// Rebuild the turn registry from session content so restored/branched
		// history renders collapsed consistently (no in-process turn_end events).
		rebuildTurnRegistryFromEntries(ctx.sessionManager.getEntries());
		coordinator.app.update({ ...usagePatch(ctx) }, "deferred");
	});
	pi.on("session_compact", (_event, ctx) => coordinator.app.update({ ...usagePatch(ctx) }, "deferred"));
	pi.on("tool_result", (event, ctx) => {
		if (["write", "edit", "bash"].includes(event.toolName)) {
			coordinator.app.runtime.current?.invalidateGit();
			coordinator.app.update({ ...usagePatch(ctx) }, "delayed-retry");
		}
	});
	pi.on("user_bash", (_event, ctx) => {
		coordinator.app.runtime.current?.invalidateGit();
		coordinator.app.update({ ...usagePatch(ctx) }, "delayed-retry");
	});
	pi.on("session_shutdown", () => {
		disposeWorkingShimmer();
		coordinator.shutdown();
	});
}

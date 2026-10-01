// Test-only extension: observe the real CLI after all session_start handlers,
// and drive deterministic tool calls without contacting an AI service.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as ai from "@earendil-works/pi-ai";

export default function (pi: any) {
	pi.registerCommand("issue4-snapshot", {
		handler: async () => {
			writeFileSync(process.env.ISSUE4_SNAPSHOT_PATH!, JSON.stringify({
				active: pi.getActiveTools(),
				available: pi.getAllTools().map((tool: any) => tool.name),
			}));
		},
	});
	pi.registerCommand("issue4-reload", { handler: async (_args: string, ctx: any) => { await ctx.reload(); } });
	pi.registerCommand("issue4-deactivate-grep", {
		handler: async () => { pi.setActiveTools(pi.getActiveTools().filter((name: string) => name !== "grep")); },
	});
	pi.registerProvider("issue4-local", {
		api: "issue4-local-api",
		apiKey: "local-test-not-a-secret",
		baseUrl: "http://127.0.0.1:1/not-used",
		models: [{
			id: "scripted", name: "Issue 4 deterministic fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024,
		}],
		streamSimple(model: any, context: any) {
			const stream = ai.createAssistantMessageEventStream();
			const message: any = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "pending", timestamp: Date.now(),
			};
			try {
				const names = ai.getCurrentTools(context.messages).map((tool: any) => tool.name);
				assert.ok(names.includes("anchor_grep") && names.includes("replace"));
				assert.ok(!names.includes("grep") && !names.includes("edit"), "conflicting tools reached the model");
				const results = context.messages.filter((entry: any) => entry.role === "toolResult");
				assert.ok(results.every((entry: any) => !entry.isError), JSON.stringify(results));
				assert.ok(results.length <= 2, "unexpected extra tool calls");
				stream.push({ type: "start", partial: message });
				if (results.length < 2) {
					let name = "anchor_grep";
					let args: any = { pattern: "const answer = 1;", path: "sample.ts", literal: true };
					if (results.length === 1) {
						assert.equal(results[0].toolName, "anchor_grep");
						const text = results[0].content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
						const anchor = text.match(/([A-Za-z]{4})│const answer = 1;/)?.[1];
						assert.ok(anchor, `grep did not serve an editable anchor: ${text}`);
						name = "replace";
						args = { remove_from: anchor, remove_to: anchor, replacement_lines: ["const answer = 2;"] };
					}
					const toolCall = { type: "toolCall" as const, id: `issue4-${results.length}`, name, arguments: {} };
					message.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					toolCall.arguments = args;
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
					message.stopReason = "toolUse";
				} else {
					assert.equal(results[1].toolName, "replace");
					const text = { type: "text", text: "" };
					message.content.push(text);
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					text.text = "Issue 4 search/edit passed";
					stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
					message.stopReason = "stop";
				}
				stream.push({ type: "done", reason: message.stopReason, message });
			} catch (error) {
				message.stopReason = "error";
				message.errorMessage = String(error);
				stream.push({ type: "error", reason: "error", error: message });
			}
			stream.end();
			return stream;
		},
	});
}

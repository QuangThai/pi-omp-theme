import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigFilePort } from "../extension-src/omp-theme/app/config-storage.js";
import { resolveConfigDetailed } from "../extension-src/omp-theme/domain/config-normalization.js";
import { renderStartup } from "../extension-src/omp-theme/features/startup/index.js";
import { createPiOmpThemeSessionCoordinator } from "../extension-src/omp-theme/pi/session-coordinator.js";
import { readRecentSessions } from "../extension-src/omp-theme/pi/recent-sessions.js";

const opening = { type: "message", message: { role: "user", content: "Opening request" } };
const info = (name: string) => ({ type: "session_info", name });
const generated = (title: string) => ({ type: "custom", customType: "pi-session-title-state", data: { title } });

function sessionFixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "pi-omp-recent-sessions-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const current = join(directory, "2026-09-24-current.jsonl");
	writeFileSync(current, `${JSON.stringify({ type: "session" })}\n`);
	return {
		current,
		add(name: string, entries: readonly unknown[]) {
			const lines = [{ type: "session" }, ...entries].map((entry) => JSON.stringify(entry)).join("\n");
			writeFileSync(join(directory, `${name}.jsonl`), `${lines}\n`);
		},
	};
}

test("recent sessions prefer the latest explicit name over later generated state", (t) => {
	const fixture = sessionFixture(t);
	fixture.add("2026-09-23-named", [opening, info("Old name"), generated("Auto title"), info("Chosen name"), generated("New auto title")]);
	assert.equal(readRecentSessions(fixture.current, 4)[0]?.name, "Chosen name");
});

test("an empty session_info clears the earlier name and restores the opening request", (t) => {
	const fixture = sessionFixture(t);
	fixture.add("2026-09-23-cleared", [opening, info("Chosen name"), info("")]);
	assert.equal(readRecentSessions(fixture.current, 4)[0]?.name, "Opening request");
});

test("clearing a manual name discards older titles but permits later generated state", (t) => {
	const fixture = sessionFixture(t);
	const name = "2026-09-23-generated";
	const entries = [opening, generated("Old auto title"), info("Chosen name"), info("")];
	fixture.add(name, entries);
	assert.equal(readRecentSessions(fixture.current, 4)[0]?.name, "Opening request");
	fixture.add(name, [...entries, generated("New auto title")]);
	assert.equal(readRecentSessions(fixture.current, 4)[0]?.name, "New auto title");
	fixture.add(name, [...entries, generated("New auto title"), generated("")]);
	assert.equal(readRecentSessions(fixture.current, 4)[0]?.name, "Opening request");
});

test("generated titles past the old 8 KiB window are found within the bounded read", (t) => {
	const fixture = sessionFixture(t);
	fixture.add("2026-09-23-long", [
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(9000) }] } },
		opening,
		generated("A useful generated title"),
	]);
	assert.equal(readRecentSessions(fixture.current, 4)[0]?.name, "A useful generated title");
});

test("multi-line generated titles stay on one rendered Welcome Card row", (t) => {
	const fixture = sessionFixture(t);
	fixture.add("2026-09-23-multiline", [opening, generated("First line\r\nSecond line")]);
	const sessions = readRecentSessions(fixture.current, 4);
	assert.equal(sessions[0]?.name, "First line Second line");

	const { config } = resolveConfigDetailed({ global: { preset: "claude" }, projectTrusted: true });
	const theme = { fg: (_color: string, text: string) => text };
	const snapshot = { reason: "startup" as const, project: "pi-omp-theme", resources: { sessions } };
	const card = renderStartup(snapshot, config, theme, 120);
	const emptyCard = renderStartup({ ...snapshot, resources: { sessions: [] } }, config, theme, 120);
	assert.equal(card.length, emptyCard.length);
	assert.ok(card.some((row) => row.includes("First line Second line")));
	assert.ok(card.every((row) => !row.includes("\n") && !row.includes("\r")));
});

test("Pi session_start reads JSONL and mounts the normalized title in the actual header", async (t) => {
	const fixture = sessionFixture(t);
	fixture.add("2026-09-23-header", [opening, info("Previous name"), info(""), generated("First line\nSecond line")]);
	let headerFactory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
	const filePort: ConfigFilePort = {
		read: async () => JSON.stringify({ piOmpTheme: { statusLine: { enabled: false }, editor: { enabled: false }, theme: { autoApply: "off" } } }),
		writeAtomic: async () => {},
	};
	const pi = { getFlag: () => false } as unknown as ExtensionAPI;
	const coordinator = createPiOmpThemeSessionCoordinator(pi, {
		filePort,
		paths: () => ({ globalPath: "<global>", projectPath: "<project>" }),
		gitRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
	});
	const context = {
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => true,
		ui: {
			setHeader(factory: unknown) { headerFactory = factory as typeof headerFactory; },
			onTerminalInput: () => () => {},
		},
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => fixture.current,
			getSessionName: () => undefined,
		},
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;
	try {
		await coordinator.start({ reason: "startup" }, context);
		assert.ok(headerFactory, "session_start should install the welcome header");
		const component = headerFactory({ requestRender() {} }, { fg: (_color: string, text: string) => text });
		const lines = component.render(120);
		assert.ok(lines.some((line) => line.includes("First line Second line")));
		assert.ok(lines.every((line) => !line.includes("\n")));
	} finally {
		coordinator.shutdown();
	}
});

test("the bounded candidate scan skips untitled files and handles missing histories", (t) => {
	const fixture = sessionFixture(t);
	fixture.add("2026-09-01-valid", [opening]);
	for (let index = 0; index < 7; index++) fixture.add(`2026-09-23-untitled-${index}`, []);
	assert.deepEqual(readRecentSessions(fixture.current, 4).map((session) => session.name), ["Opening request"]);
	assert.deepEqual(readRecentSessions(fixture.current, 0), []);
	assert.deepEqual(readRecentSessions(join(fixture.current, "missing"), 4), []);
});

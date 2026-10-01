import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

// Explicit opt-in gate: downloads pinned test dependencies, never installs into
// the developer's Pi directory or makes external model requests.
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run via npm run test:e2e:readonly-tools");
const piVersion = process.env.PI_E2E_PI_VERSION || "0.99.1";
const hashlineVersion = "4.5.1";
const repo = process.cwd();
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const root = mkdtempSync(join(tmpdir(), "pi-omp-readonly-e2e-"));
const runtime = join(root, "runtime");
const probe = resolve("scripts/e2e/readonly-tools-probe.ts");
const core = ["read", "bash", "edit", "write"];
const readonly = ["grep", "find", "ls"];
const hashTools = ["read", "bash", "write", "replace", "insert", "copy", "move", "anchor_grep", "undo_last_change"];
const flag = "--pi-omp-theme-readonly-tools";
const results = [];
let passed = false;
const npm = (args, cwd = repo) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: "utf8", timeout: 180000, maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const sorted = (values) => [...values].sort();

try {
  console.log(`E2E sandbox: ${root}`);
  const pack = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root]))[0];
  mkdirSync(runtime);
  npm(["install", "--prefix", runtime, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
    `@earendil-works/pi-coding-agent@${piVersion}`, `pi-hashline-edit-pro@${hashlineVersion}`, join(root, pack.filename)]);
  const modules = join(runtime, "node_modules");
  const piRoot = join(modules, "@earendil-works/pi-coding-agent");
  assert.equal(JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version, piVersion);
  assert.equal(JSON.parse(readFileSync(join(modules, "pi-hashline-edit-pro/package.json"), "utf8")).version, hashlineVersion);
  assert.equal(readFileSync(join(modules, "@nguyenquangthai/pi-omp-theme/dist/extensions/pi-omp-theme.ts"), "utf8"),
    readFileSync(resolve("dist/extensions/pi-omp-theme.ts"), "utf8"), "E2E must exercise the newly packed bundle");
  const { RpcClient } = await import(pathToFileURL(join(piRoot, "dist/modes/rpc/rpc-client.js")).href);
  const sources = {
    theme: `npm:${manifest.name}@${manifest.version}`,
    hashline: `npm:pi-hashline-edit-pro@${hashlineVersion}`,
  };
  const cases = [
    { name: "theme-default", expected: core },
    { name: "hashline-control", order: ["hashline"], expected: hashTools },
    ...[["hashline", "theme"], ["theme", "hashline"]].flatMap((order) => [
      { name: `default-${order.join("-")}`, order, expected: hashTools, edit: true, boundaries: true },
      { name: `disabled-${order.join("-")}`, order, config: { readonlyTools: false }, expected: hashTools },
    ]),
    { name: "config-opt-in", config: { readonlyTools: true }, expected: [...core, ...readonly], presentationReload: true },
    { name: "cli-true-equals", args: [`${flag}=true`], expected: [...core, ...readonly] },
    { name: "cli-true-space", config: { readonlyTools: false }, args: [flag, "true"], expected: [...core, ...readonly] },
    ...[[`${flag}=false`], [flag, "false"]].map((args, index) => ({
      name: `cli-false-${index}`, order: ["hashline", "theme"], config: { readonlyTools: true }, args, expected: hashTools,
    })),
    { name: "extension-disabled", config: { enabled: false, readonlyTools: true }, args: [`${flag}=true`], expected: core },
    { name: "environment-disabled", config: { readonlyTools: true }, args: [`${flag}=true`], disabledEnv: true, expected: core },
    { name: "project-opt-in-trusted", project: { readonlyTools: true }, trusted: true, expected: [...core, ...readonly] },
    { name: "project-opt-in-untrusted", project: { readonlyTools: true }, expected: core },
    { name: "project-opt-out-trusted", config: { readonlyTools: true }, project: { readonlyTools: false }, trusted: true, expected: core },
    { name: "project-opt-out-untrusted", config: { readonlyTools: true }, project: { readonlyTools: false }, expected: [...core, ...readonly] },
    { name: "invalid-config", config: { readonlyTools: "true" }, expected: core },
    { name: "invalid-cli", config: { readonlyTools: true }, args: [`${flag}=nope`], expected: core, warning: true },
    { name: "exclude-grep", order: ["hashline", "theme"], config: { readonlyTools: true }, args: ["--exclude-tools", "grep"], expected: [...hashTools, "find", "ls"] },
    { name: "tool-allowlist", config: { readonlyTools: true }, args: ["--tools", "read,bash,write"], expected: ["read", "bash", "write"] },
    { name: "no-tools", config: { readonlyTools: true }, args: ["--no-tools"], expected: [] },
    { name: "user-selected-grep-preserved", defaultTools: ["+grep"], expected: [...core, "grep"] },
    { name: "config-change-at-boundary", config: { readonlyTools: true }, expected: [...core, ...readonly], changeConfig: true },
    { name: "missing-cli-value", args: [flag], cliError: /requires a value/ },
  ];
  for (const entry of cases) {
    const sandbox = join(root, entry.name);
    const cwd = join(sandbox, "work");
    const agentDir = join(sandbox, "agent");
    const snapshotPath = join(sandbox, "snapshot.json");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(join(agentDir, "npm"), { recursive: true });
    // The same installed artifact is mounted in each isolated Pi npm storage.
    symlinkSync(modules, join(agentDir, "npm/node_modules"), process.platform === "win32" ? "junction" : "dir");
    const settings = {
      packages: (entry.order ?? ["theme"]).map((name) => sources[name]),
      piOmpTheme: entry.config ?? {},
      ...(entry.defaultTools ? { defaultTools: entry.defaultTools } : {}),
    };
    json(join(agentDir, "settings.json"), settings);
    json(join(cwd, ".pi/settings.json"), { piOmpTheme: entry.project ?? {} });
    writeFileSync(join(cwd, "sample.ts"), "const answer = 1;\nexport { answer };\n");
    const env = {
      ...Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith("PI_OMP_THEME_")).map((key) => [key, ""])),
      HOME: sandbox, USERPROFILE: sandbox, PI_CODING_AGENT_DIR: agentDir,
      PI_HASHLINE_DIR: join(sandbox, "hashline"), PI_OFFLINE: "1", ISSUE4_SNAPSHOT_PATH: snapshotPath,
      PI_OMP_THEME_DISABLED: entry.disabledEnv ? "1" : "", PI_HASHLINE_DEBUG: "",
    };
    const client = new RpcClient({
      cliPath: join(piRoot, "dist/cli.js"), cwd, env, provider: "issue4-local", model: "scripted",
      args: ["--offline", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files",
        entry.trusted ? "--approve" : "--no-approve", "-e", probe, ...(entry.args ?? [])],
    });
    const events = [];
    const unsubscribe = client.onEvent((event) => events.push(event));
    const snapshot = async (expected = entry.expected) => {
      assert.equal(await client.prompt("/issue4-snapshot"), "handled");
      const state = JSON.parse(readFileSync(snapshotPath, "utf8"));
      assert.deepEqual(sorted(state.active), sorted(expected), `${entry.name}: active tools`);
      // Without CLI restrictions, inactive native tools must still be registered.
      // Pi deliberately removes excluded/non-allowlisted tools from getAllTools().
      const restricted = entry.args?.some((arg) => ["--exclude-tools", "--tools", "--no-tools"].includes(arg));
      if (!restricted) assert.ok(readonly.every((name) => state.available.includes(name)));
      return state;
    };
    try {
      if (entry.cliError) {
        await assert.rejects(async () => { await client.start(); await client.getState(); }, entry.cliError);
      } else {
        await client.start();
        const commands = await client.getCommands();
        if ((entry.order ?? ["theme"]).includes("theme")) assert.ok(commands.some((command) => command.name === "pi-omp-theme"));
        if (entry.order?.includes("hashline")) assert.ok(commands.some((command) => command.name === "hashline-config"));
        await snapshot();
        if (entry.warning) assert.ok(events.some((event) => event.type === "extension_ui_request" && /expects true or false/.test(event.message)));
        if (entry.edit) {
          const editEvents = await client.promptAndWait("Run the issue 4 search/edit fixture.", undefined, 30000);
          assert.deepEqual(editEvents.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName), ["anchor_grep", "replace"]);
          assert.ok(editEvents.filter((event) => event.type === "tool_execution_end").every((event) => !event.isError));
          assert.equal(await client.getLastAssistantText(), "Issue 4 search/edit passed");
          assert.equal(readFileSync(join(cwd, "sample.ts"), "utf8"), "const answer = 2;\nexport { answer };\n");
        }
        if (entry.boundaries) {
          assert.equal((await client.newSession()).cancelled, false);
          await snapshot();
          assert.equal(await client.prompt("/issue4-reload"), "handled");
          await snapshot();
        }
        if (entry.presentationReload) {
          assert.equal(await client.prompt("/issue4-deactivate-grep"), "handled");
          assert.equal(await client.prompt("/pi-omp-theme reload"), "handled");
          await snapshot([...core, "find", "ls"]);
        }
        if (entry.changeConfig) {
          settings.piOmpTheme = { readonlyTools: false };
          json(join(agentDir, "settings.json"), settings);
          assert.equal(await client.prompt("/issue4-deactivate-grep"), "handled");
          assert.equal(await client.prompt("/issue4-reload"), "handled");
          await snapshot([...core, "find", "ls"]);
          await client.newSession();
          await snapshot(core);
        }
        const errors = events.filter((event) => event.type === "extension_error" || event.type === "agent_error");
        assert.deepEqual(errors, [], `${entry.name}: extension/runtime errors`);
        assert.doesNotMatch(client.getStderr(), /Failed to load extension|Failed to refresh edit tools|Failed to load hash store|Theme not initialized/);
      }
      results.push({ name: entry.name, status: "passed" });
      console.log(`PASS ${entry.name}`);
    } finally {
      unsubscribe();
      writeFileSync(join(sandbox, "stderr.log"), client.getStderr());
      json(join(sandbox, "events.json"), events);
      await client.stop();
    }
  }
  passed = true;
  console.log(`E2E: ${results.length}/${cases.length} passed (Pi ${piVersion}, hashline ${hashlineVersion}, packed theme ${manifest.version})`);
} finally {
  json(join(root, "report.json"), { piVersion, hashlineVersion, themeVersion: manifest.version, passed, results });
  if (passed && !process.argv.includes("--keep-temp")) rmSync(root, { recursive: true, force: true });
  else console.log(`E2E evidence retained: ${root}`);
}

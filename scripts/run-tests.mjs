import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const outputDir = resolve(".tmp-tests");
const tsc = resolve("node_modules/typescript/bin/tsc");
let exitCode = 0;

function compiledTests(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) return compiledTests(path);
		return entry.isFile() && entry.name.endsWith(".test.js") ? [path] : [];
	});
}

rmSync(outputDir, { recursive: true, force: true });
try {
	const compile = spawnSync(
		process.execPath,
		[
			tsc,
			"-p",
			"tsconfig.json",
			"--outDir",
			outputDir,
			"--noEmit",
			"false",
			"--declaration",
			"false",
			"--sourceMap",
			"false",
		],
		{ stdio: "inherit" },
	);
	exitCode = compile.status ?? 1;

	if (exitCode === 0) {
		const testsDir = resolve(outputDir, "tests");
		const testFiles = compiledTests(testsDir).sort();
		if (testFiles.length === 0) throw new Error("no compiled test files found");
		const run = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
		exitCode = run.status ?? 1;
	}
} finally {
	rmSync(outputDir, { recursive: true, force: true });
}

process.exitCode = exitCode;

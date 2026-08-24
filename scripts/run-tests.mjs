import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const outputDir = resolve(".tmp-tests");
const tsc = resolve("node_modules/typescript/bin/tsc");
let exitCode = 0;

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
		const run = spawnSync(process.execPath, ["--test", resolve(outputDir, "tests/grep-renderer.test.js")], {
			stdio: "inherit",
		});
		exitCode = run.status ?? 1;
	}
} finally {
	rmSync(outputDir, { recursive: true, force: true });
}

process.exitCode = exitCode;

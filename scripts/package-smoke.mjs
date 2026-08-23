import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const expected = {
  name: "@nguyenquangthai/pi-omp-theme",
  version: "1.0.0",
  entry: "./dist/extensions/pi-omp-theme.js",
  repository: "git+https://github.com/QuangThai/pi-omp-theme.git",
};

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(manifest.name, expected.name);
assert.equal(manifest.version, expected.version);
assert.equal(manifest.repository?.url, expected.repository);
assert.equal(manifest.publishConfig?.access, "public");
assert.deepEqual(manifest.pi?.extensions, [expected.entry]);
assert.ok(existsSync(expected.entry), `missing compiled extension: ${expected.entry}`);

const extension = await import(`${pathToFileURL(resolve(expected.entry)).href}?smoke=${Date.now()}`);
assert.equal(typeof extension.default, "function", "compiled extension must export a default factory");

for (const file of ["themes/titanium.json", "themes/titanium-light.json"]) {
  const theme = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(typeof theme.name, "string", `${file}: missing name`);
  assert.ok(Object.keys(theme.colors ?? {}).length >= 51, `${file}: incomplete color map`);
}

const readme = readFileSync("README.md", "utf8");
for (const match of readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
  const target = match[1]?.trim();
  if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue;
  assert.ok(existsSync(target.split("#")[0]), `README.md: broken local link ${target}`);
}

const npmExecutable = process.env.npm_execpath ? process.execPath : "npm";
const npmArguments = [
  ...(process.env.npm_execpath ? [process.env.npm_execpath] : []),
  "pack",
  "--dry-run",
  "--ignore-scripts",
  "--json",
];
const packed = JSON.parse(
  execFileSync(npmExecutable, npmArguments, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
)[0];
const actualFiles = packed.files.map(({ path }) => path).sort();
const expectedFiles = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "dist/extensions/pi-omp-theme.js",
  "package.json",
  "themes/titanium-light.json",
  "themes/titanium.json",
].sort();
assert.deepEqual(actualFiles, expectedFiles, "npm artifact contains missing or unexpected files");

console.log(`package smoke: ${expected.name}@${expected.version}, ${actualFiles.length} files`);

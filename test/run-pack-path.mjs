#!/usr/bin/env node
// Runs the verify action's pack path, as a release runs it: the scripts of
// its steps, read from verify/action.yml, against the fixture workspace in
// test/fixtures/pack-workspace. CI runs this inside the browser test image
// that releases verify in (ADR 0025 and ADR 0041, in sdk-core), where tools
// such as jq aren't installed.
//
// Usage: node test/run-pack-path.mjs
//
// It runs the pack path twice:
// 1. with the package built: every step must pass, and the plan's hash must
//    be recorded;
// 2. without dist/: the tarball check must fail and name the missing files,
//    as it would have for sdk-core 0.1.3 and 0.2.0.
//
// It needs the fixture's dependencies (`pnpm install --frozen-lockfile` in
// the fixture), this repository's for `yaml`, and the network: the publish
// plan asks npm whether the fixture's version exists.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(ROOT, "test", "fixtures", "pack-workspace");
const PACKAGE = join(FIXTURE, "packages", "demo");
const STEPS = [
  "Check the inputs",
  "Plan the release",
  "Pack the packages",
  "Check the tarballs",
  "Record the plan's hash",
];

const { runs } = parse(readFileSync(join(ROOT, "verify", "action.yml"), "utf8"));
/** @type {Map<string, string>} */
const scripts = new Map(
  runs.steps.filter((step) => STEPS.includes(step.name)).map((step) => [step.name, step.run]),
);
for (const name of STEPS) {
  if (!scripts.has(name)) {
    throw new Error(`verify/action.yml has no "${name}" step`);
  }
}

/**
 * Runs the pack path's steps in order, stopping at the first that fails.
 *
 * @returns {{ failed?: string, output: string, outputs: string }}
 */
function packPath() {
  const temp = mkdtempSync(join(tmpdir(), "pack-path-"));
  const outputFile = join(temp, "github-output");
  writeFileSync(outputFile, "");
  let output = "";
  try {
    for (const name of STEPS) {
      const result = spawnSync("bash", ["-e", "-c", /** @type {string} */ (scripts.get(name))], {
        cwd: FIXTURE,
        encoding: "utf8",
        env: {
          ...process.env,
          CACHE: "false",
          PACK: "true",
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: outputFile,
          GITHUB_ACTION_PATH: join(ROOT, "verify"),
        },
      });
      output += `--- ${name}\n${result.stdout}${result.stderr}`;
      if (result.status !== 0) {
        return { failed: name, output, outputs: readFileSync(outputFile, "utf8") };
      }
    }
    return { output, outputs: readFileSync(outputFile, "utf8") };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** @param {boolean} condition @param {string} message @param {string} output */
function expect(condition, message, output) {
  if (!condition) {
    process.stderr.write(`${output}\n::error::${message}\n`);
    process.exit(1);
  }
}

rmSync(join(PACKAGE, "dist"), { recursive: true, force: true });
const build = spawnSync("node", ["build.mjs"], { cwd: PACKAGE, encoding: "utf8" });
expect(build.status === 0, "The fixture didn't build.", `${build.stdout}${build.stderr}`);

const built = packPath();
expect(
  built.failed === undefined,
  `The pack path failed at "${built.failed}" with the package built.`,
  built.output,
);
expect(built.outputs.includes("pending=true"), "The plan found nothing to publish.", built.output);
expect(/^sha256=[0-9a-f]{64}$/m.test(built.outputs), "No plan hash was recorded.", built.output);
process.stdout.write("The pack path passes with the package built.\n");

rmSync(join(PACKAGE, "dist"), { recursive: true, force: true });
const unbuilt = packPath();
expect(
  unbuilt.failed === "Check the tarballs",
  `Without dist/, the pack path ${unbuilt.failed ? `failed at "${unbuilt.failed}"` : "passed"} instead of failing the tarball check.`,
  unbuilt.output,
);
expect(
  unbuilt.output.includes("dist/index.js (exports") &&
    unbuilt.output.includes("dist/index.d.ts (exports"),
  "The tarball check didn't name the missing files.",
  unbuilt.output,
);
process.stdout.write("Without dist/, the tarball check fails and names the missing files.\n");

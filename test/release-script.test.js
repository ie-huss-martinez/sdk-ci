// Tests scripts/release.mjs, which tags sdk-ci's releases, through its real
// command line, with a fake `gh` that serves tags and records the release.
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
const SHA = "a".repeat(40);

// The fake gh: `api …/matching-refs/tags/v` lists $FAKE_TAGS, and
// `release create` records its arguments and notes.
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  const tags = JSON.parse(process.env.FAKE_TAGS || "[]");
  process.stdout.write(JSON.stringify(tags.map((tag) => ({ ref: "refs/tags/" + tag }))));
} else if (args[0] === "release" && args[1] === "create") {
  const notes = readFileSync(args[args.indexOf("--notes-file") + 1], "utf8");
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ notes }) + "\\n");
} else {
  process.exit(2);
}
`;

const CHANGELOG = `# Changelog

## v1.1.0

- Added a thing.

## v1.0.0

- The first release.
`;

/**
 * Runs the script in a temporary project with this package.json version and
 * changelog, and these existing tags.
 *
 * @param {{ version: string, changelog?: string, tags?: string[], args?: string[] }} setup
 * @param {(fn: () => Promise<void>) => void} onTestFinished
 */
async function release({ version, changelog = CHANGELOG, tags = [], args = [] }, onTestFinished) {
  const dir = await mkdtemp(join(tmpdir(), "hm-sdk-ci-release-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "bin"));
  await writeFile(join(dir, "bin", "gh"), FAKE_GH);
  await chmod(join(dir, "bin", "gh"), 0o755);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "sdk-ci", version }));
  await writeFile(join(dir, "CHANGELOG.md"), changelog);
  const log = join(dir, "gh.log");
  await writeFile(log, "");
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env["PATH"]}`,
          GITHUB_REPOSITORY: "ie-huss-martinez/sdk-ci",
          GITHUB_SHA: SHA,
          FAKE_LOG: log,
          FAKE_TAGS: JSON.stringify(tags),
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });
  const calls = (await readFile(log, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { .../** @type {{ code: number, stdout: string, stderr: string }} */ (result), calls };
}

const created = (calls) => calls.find((call) => Array.isArray(call) && call[1] === "create");

describe.concurrent("the release script", () => {
  it("tags a new version at the merged commit, with its changelog section as notes", async ({
    onTestFinished,
  }) => {
    const run = await release({ version: "1.1.0", tags: ["v1.0.0"] }, onTestFinished);

    expect(run.code, run.stderr).toBe(0);
    expect(created(run.calls)).toEqual([
      "release",
      "create",
      "v1.1.0",
      "--repo",
      "ie-huss-martinez/sdk-ci",
      "--target",
      SHA,
      "--title",
      "v1.1.0",
      "--notes-file",
      expect.any(String),
    ]);
    expect(run.calls.find((call) => call.notes)).toEqual({ notes: "- Added a thing.\n" });
    expect(run.stdout).toContain(`Released v1.1.0 at ${SHA}.`);
  });

  it("releases the first version when there are no tags yet", async ({ onTestFinished }) => {
    const run = await release({ version: "1.0.0" }, onTestFinished);

    expect(run.code, run.stderr).toBe(0);
    expect(created(run.calls)?.[2]).toBe("v1.0.0");
    expect(run.calls.find((call) => call.notes)).toEqual({ notes: "- The first release.\n" });
  });

  it("does nothing when the version is already released", async ({ onTestFinished }) => {
    const run = await release({ version: "1.0.0", tags: ["v1.0.0"] }, onTestFinished);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("v1.0.0 is already released; nothing to do.");
    expect(created(run.calls)).toBeUndefined();
  });

  it("refuses a version lower than the latest release", async ({ onTestFinished }) => {
    const run = await release(
      { version: "1.0.0", tags: ["v1.1.0", "v1.10.0", "v1.9.0"] },
      onTestFinished,
    );

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("v1.0.0 is lower than the latest release, v1.10.0.");
    expect(created(run.calls)).toBeUndefined();
  });

  it.for([
    ["a version that isn't MAJOR.MINOR.PATCH", { version: "1.0" }, "must be MAJOR.MINOR.PATCH"],
    ["a prerelease", { version: "1.0.0-beta.1" }, "must be MAJOR.MINOR.PATCH"],
    ["no changelog section", { version: "2.0.0" }, 'has no "## v2.0.0" section'],
    [
      "an empty changelog section",
      { version: "1.2.0", changelog: "# Changelog\n\n## v1.2.0\n\n## v1.1.0\n\n- Old.\n" },
      '"## v1.2.0" section is empty',
    ],
  ])("refuses %s, without calling GitHub", async ([, setup, message], { onTestFinished }) => {
    const run = await release(/** @type {{ version: string }} */ (setup), onTestFinished);

    expect(run.code).toBe(1);
    expect(run.stderr.toLowerCase()).toContain(message.toLowerCase());
    expect(run.calls).toEqual([]);
  });

  it("releases nothing at 0.0.0, before the first release", async ({ onTestFinished }) => {
    for (const args of [[], ["--check"]]) {
      const run = await release(
        { version: "0.0.0", changelog: "# Changelog\n", args },
        onTestFinished,
      );

      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toBe("Version 0.0.0: nothing to release yet.\n");
      expect(run.calls).toEqual([]);
    }
  });

  it("only checks with --check, without calling GitHub", async ({ onTestFinished }) => {
    const run = await release({ version: "1.1.0", args: ["--check"] }, onTestFinished);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe("v1.1.0: valid, with release notes in CHANGELOG.md.\n");
    expect(run.calls).toEqual([]);
  });
});

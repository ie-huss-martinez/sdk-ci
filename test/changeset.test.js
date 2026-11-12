// Tests changeset/dev-only.mjs, which leaves dev-only package.json changes
// out of the changeset check (ADR 0027, in sdk-core). Each test builds a git
// repository with a base commit as origin/main and a pull request's commit on
// top, runs the script's real command line, and checks what
// `git diff --name-only <merge-base>` then lists: exactly what
// `changeset status --since=origin/main` counts.
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../changeset/dev-only.mjs", import.meta.url));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** A published package, as most of the family's package.json files look. */
const PACKAGE = {
  name: "@hussmartinez/example",
  version: "1.0.0",
  type: "module",
  exports: { ".": "./dist/index.js" },
  engines: { node: ">=24" },
  scripts: { build: "vite build", test: "vitest run" },
  dependencies: { "@hussmartinez/sdk-core": "^0.1.3" },
  devDependencies: { vite: "^8.3.6", vitest: "^5.1.0" },
  packageManager: "pnpm@12.18.0",
};

/** A monorepo like sdk-core and ui: a private root and packages/*. */
const MONOREPO = {
  "package.json": json({ name: "workspace", private: true, devDependencies: { husky: "^9.1.7" } }),
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "packages/example/package.json": json(PACKAGE),
  "packages/example/src/index.js": "export const a = 1;\n",
};

/** A single package at the repository root, like pdf-sdk. */
const ROOT_PACKAGE = {
  "package.json": json(PACKAGE),
  "src/index.js": "export const a = 1;\n",
};

/**
 * Builds the repository, applies the pull request's changes, runs the script,
 * and returns its result and the files Changesets would then count.
 *
 * @param {Record<string, string>} files
 * @param {Record<string, string | null>} changes Files to write, or delete with null.
 * @param {(fn: () => Promise<void>) => void} onTestFinished
 */
async function check(files, changes, onTestFinished) {
  const repo = await mkdtemp(join(tmpdir(), "hm-changeset-dev-only-"));
  onTestFinished(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
  const write = async (all) => {
    for (const [path, content] of Object.entries(all)) {
      if (content === null) {
        await rm(join(repo, path));
      } else {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), content);
      }
    }
  };
  await write(files);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "change");
  await write(changes);
  git("add", "-A");
  git("commit", "-q", "-m", "change");

  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, "origin/main"],
      { cwd: repo, env: GIT_ENV, encoding: "utf8" },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });
  const base = git("merge-base", "origin/main", "HEAD");
  const counted = git("diff", "--name-only", "--no-relative", base).split("\n").filter(Boolean);
  return {
    .../** @type {{ code: number, stdout: string, stderr: string }} */ (result),
    counted,
    read: (path) => readFile(join(repo, path), "utf8"),
  };
}

/** PACKAGE with these changes, as the pull request's package.json. */
const changed = (change) => json({ ...PACKAGE, ...change });

const FILE = "packages/example/package.json";

describe.concurrent("leaving out dev-only package.json changes", () => {
  it.for([
    [
      "a devDependencies update",
      { devDependencies: { vite: "^8.4.0", vitest: "^5.1.0" } },
      "devDependencies",
    ],
    ["a scripts change", { scripts: { build: "vite build --mode lib" } }, "scripts"],
    ["a packageManager update", { packageManager: "pnpm@12.19.0" }, "packageManager"],
    ["a devEngines field", { devEngines: { runtime: { name: "node" } } }, "devEngines"],
    [
      "several dev-only fields at once",
      { scripts: {}, devDependencies: {}, packageManager: "pnpm@12.19.0" },
      "devDependencies, packageManager, scripts",
    ],
  ])("doesn't count %s", async ([, change, fields], { onTestFinished }) => {
    const run = await check(MONOREPO, { [FILE]: changed(change) }, onTestFinished);

    expect(run.code, run.stderr).toBe(0);
    expect(run.counted).toEqual([]);
    expect(run.stdout).toContain(
      `${FILE}: only ${fields} changed, so it isn't counted (ADR 0027).`,
    );
    // Exactly the committed base, byte for byte.
    expect(await run.read(FILE)).toBe(json(PACKAGE));
  });

  it.for([
    [
      "a dependencies update",
      { dependencies: { "@hussmartinez/sdk-core": "^0.2.0" } },
      "dependencies",
    ],
    ["engines", { engines: { node: ">=26" } }, "engines"],
    ["exports", { exports: { ".": "./dist/main.js" } }, "exports"],
    ["the version", { version: "1.0.1" }, "version"],
    ["private", { private: true }, "private"],
    ["a field the list doesn't name", { funding: "https://example.com" }, "funding"],
    [
      "a dev-only field together with dependencies",
      { devDependencies: {}, dependencies: { "@hussmartinez/sdk-core": "^0.2.0" } },
      "dependencies",
    ],
  ])("counts %s", async ([, change, fields], { onTestFinished }) => {
    const run = await check(MONOREPO, { [FILE]: changed(change) }, onTestFinished);

    expect(run.code, run.stderr).toBe(0);
    expect(run.counted).toEqual([FILE]);
    expect(run.stdout).toContain(`${FILE}: ${fields} changed, which reach users, so it counts.`);
  });

  it("doesn't count a change of key order or formatting alone", async ({ onTestFinished }) => {
    const reordered = `${JSON.stringify(Object.fromEntries(Object.entries(PACKAGE).reverse()))}\n`;
    const run = await check(MONOREPO, { [FILE]: reordered }, onTestFinished);

    expect(run.counted).toEqual([]);
    expect(run.stdout).toContain(`${FILE}: only formatting changed`);
  });

  it("still counts the package's source when its package.json change is dev-only", async ({
    onTestFinished,
  }) => {
    const run = await check(
      MONOREPO,
      {
        [FILE]: changed({ devDependencies: {} }),
        "packages/example/src/index.js": "export const a = 2;\n",
      },
      onTestFinished,
    );

    expect(run.counted).toEqual(["packages/example/src/index.js"]);
  });

  it("counts a new package", async ({ onTestFinished }) => {
    const run = await check(
      MONOREPO,
      { "packages/other/package.json": json({ ...PACKAGE, name: "@hussmartinez/other" }) },
      onTestFinished,
    );

    expect(run.counted).toEqual(["packages/other/package.json"]);
  });

  it("fails, leaving everything counted, when the workspace can't be listed", async ({
    onTestFinished,
  }) => {
    // pnpm refuses an invalid package.json; in the action, the install before
    // this step already fails on it.
    const run = await check(MONOREPO, { [FILE]: "{ not json" }, onTestFinished);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      "::error::Can't list the workspace's packages, so nothing is left out",
    );
    expect(run.counted).toEqual([FILE]);
  });

  it("leaves a private package alone, as Changesets ignores it", async ({ onTestFinished }) => {
    const root = json({ name: "workspace", private: true, devDependencies: { husky: "^9.2.0" } });
    const run = await check(MONOREPO, { "package.json": root }, onTestFinished);

    expect(run.counted).toEqual(["package.json"]);
    expect(await run.read("package.json")).toBe(root);
    expect(run.stdout).toBe("No dev-only package.json changes to leave out.\n");
  });

  it("works for a package at the repository root, as in pdf-sdk", async ({ onTestFinished }) => {
    const devOnly = await check(
      ROOT_PACKAGE,
      { "package.json": changed({ devDependencies: { vite: "^8.4.0" } }) },
      onTestFinished,
    );
    const userFacing = await check(
      ROOT_PACKAGE,
      { "package.json": changed({ dependencies: {} }) },
      onTestFinished,
    );

    expect(devOnly.counted).toEqual([]);
    expect(devOnly.stdout).toContain("package.json: only devDependencies changed");
    expect(userFacing.counted).toEqual(["package.json"]);
  });

  it("changes nothing when no package.json changed", async ({ onTestFinished }) => {
    const run = await check(
      MONOREPO,
      { "packages/example/src/index.js": "export const a = 2;\n" },
      onTestFinished,
    );

    expect(run.code, run.stderr).toBe(0);
    expect(run.counted).toEqual(["packages/example/src/index.js"]);
    expect(run.stdout).toBe("No dev-only package.json changes to leave out.\n");
  });
});

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { missingPaths, referencedPaths } from "../publish/check-tarballs.mjs";

const SCRIPT = fileURLToPath(new URL("../publish/check-tarballs.mjs", import.meta.url));

describe("referencedPaths", () => {
  it("collects main, module, types, typings, bin and every exports target", () => {
    const paths = referencedPaths({
      main: "./dist/index.js",
      module: "dist/index.mjs",
      types: "./dist/index.d.ts",
      typings: "./dist/legacy.d.ts",
      bin: { "hm-tool": "./bin/tool.js" },
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./element": { import: ["./dist/element.js"] },
        "./styles.css": "./dist/styles.css",
        "./tsconfig/*": "./tsconfig/*.json",
        "./internal": null,
      },
    });

    expect(paths).toEqual([
      { path: "dist/index.js", field: "main" },
      { path: "dist/index.mjs", field: "module" },
      { path: "dist/index.d.ts", field: "types" },
      { path: "dist/legacy.d.ts", field: "typings" },
      { path: "bin/tool.js", field: "bin.hm-tool" },
      { path: "dist/index.d.ts", field: 'exports["."]["types"]' },
      { path: "dist/index.js", field: 'exports["."]["default"]' },
      { path: "dist/element.js", field: 'exports["./element"]["import"][0]' },
      { path: "dist/styles.css", field: 'exports["./styles.css"]' },
      { path: "tsconfig/*.json", field: 'exports["./tsconfig/*"]' },
    ]);
  });

  it("reads a string bin and a string exports", () => {
    expect(referencedPaths({ bin: "./cli.js", exports: "./index.js" })).toEqual([
      { path: "cli.js", field: "bin" },
      { path: "index.js", field: "exports" },
    ]);
  });
});

describe("missingPaths", () => {
  const files = new Set([
    "package.json",
    "dist/index.js",
    "tsconfig/base.json",
    "tsconfig/dom/x.json",
  ]);

  it("finds paths that aren't files", () => {
    expect(
      missingPaths(
        [
          { path: "dist/index.js", field: "main" },
          { path: "dist/index.d.ts", field: "types" },
        ],
        files,
      ),
    ).toEqual([{ path: "dist/index.d.ts", field: "types" }]);
  });

  it("matches a * pattern against any file, across directories, and needs at least one", () => {
    expect(missingPaths([{ path: "tsconfig/*.json", field: "exports" }], files)).toEqual([]);
    expect(missingPaths([{ path: "lib/*.js", field: "exports" }], files)).toEqual([
      { path: "lib/*.js", field: "exports" },
    ]);
  });

  it("treats a pattern's other characters literally", () => {
    expect(missingPaths([{ path: "dist/index.js+*", field: "exports" }], files)).toHaveLength(1);
  });
});

/**
 * Creates a pack directory, as `changeset pack` writes it: real tarballs,
 * with a `package/` root, and a publish plan that lists them.
 *
 * @param {Array<{ name: string, version: string, files: Record<string, string> }>} packages
 */
async function packDir(packages) {
  const dir = await mkdtemp(join(tmpdir(), "check-tarballs-"));
  const steps = [];
  for (const pkg of packages) {
    const source = join(dir, "src", pkg.name.replace("/", "__"), "package");
    for (const [path, content] of Object.entries(pkg.files)) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), content);
    }
    const file = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
    execFileSync("tar", ["-czf", join(dir, file), "-C", dirname(source), "package"]);
    const bytes = await readFile(join(dir, file));
    steps.push({
      kind: "publish",
      name: pkg.name,
      version: pkg.version,
      tarball: {
        path: file,
        integrity: `sha256-${createHash("sha256").update(bytes).digest("base64")}`,
      },
    });
  }
  await writeFile(join(dir, "publish-plan.json"), JSON.stringify({ plan: [steps] }));
  return dir;
}

/** @param {string[]} args @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
const run = (args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });

const MANIFEST = JSON.stringify({
  name: "@hussmartinez/sdk-core",
  version: "0.3.0",
  type: "module",
  exports: {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./element": { types: "./dist/element.d.ts", default: "./dist/element.js" },
    "./package.json": "./package.json",
  },
});

const COMPLETE = {
  name: "@hussmartinez/sdk-core",
  version: "0.3.0",
  files: {
    "package.json": MANIFEST,
    "README.md": "# sdk-core\n",
    "dist/index.js": "export {};\n",
    "dist/index.d.ts": "export {};\n",
    "dist/element.js": "export {};\n",
    "dist/element.d.ts": "export {};\n",
  },
};

/** What sdk-core 0.1.3 and 0.2.0 shipped: no dist. */
const WITHOUT_DIST = {
  name: "@hussmartinez/sdk-core",
  version: "0.3.0",
  files: { "package.json": MANIFEST, "README.md": "# sdk-core\n", LICENSE: "Apache-2.0\n" },
};

describe("check-tarballs.mjs", () => {
  it("passes a tarball that has every referenced file", async ({ onTestFinished }) => {
    const dir = await packDir([COMPLETE]);
    onTestFinished(() => rm(dir, { recursive: true, force: true }));

    await expect(run([dir])).resolves.toMatchObject({
      code: 0,
      stdout: "@hussmartinez/sdk-core@0.3.0: every referenced file is in the tarball.\n",
    });
  });

  it("fails a tarball without dist, naming each missing path", async ({ onTestFinished }) => {
    const dir = await packDir([WITHOUT_DIST]);
    onTestFinished(() => rm(dir, { recursive: true, force: true }));

    const result = await run([dir]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "::error title=Incomplete tarball::@hussmartinez/sdk-core@0.3.0: 4 problems, so nothing is published.",
    );
    for (const path of [
      "dist/index.d.ts",
      "dist/index.js",
      "dist/element.d.ts",
      "dist/element.js",
    ]) {
      expect(result.stderr).toContain(`@hussmartinez/sdk-core@0.3.0: ${path} (exports`);
    }
  });

  it("checks every package, and fails if any is incomplete", async ({ onTestFinished }) => {
    const config = {
      name: "@hussmartinez/sdk-config",
      version: "0.2.0",
      files: {
        "package.json": JSON.stringify({ bin: { "hm-lint-deps": "./src/cli.js" } }),
        "src/cli.js": "",
      },
    };
    const dir = await packDir([config, WITHOUT_DIST]);
    onTestFinished(() => rm(dir, { recursive: true, force: true }));

    const result = await run([dir]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "@hussmartinez/sdk-config@0.2.0: every referenced file is in the tarball.",
    );
    expect(result.stderr).toContain("@hussmartinez/sdk-core@0.3.0: 4 problems");
  });

  it("fails a plan step without a tarball", async ({ onTestFinished }) => {
    const dir = await mkdtemp(join(tmpdir(), "check-tarballs-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
      join(dir, "publish-plan.json"),
      JSON.stringify({
        plan: [[{ kind: "publish", name: "x", version: "1.0.0" }, { kind: "skip" }]],
      }),
    );

    await expect(run([dir])).resolves.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("x@1.0.0: the plan has no tarball."),
    });
  });

  it("runs publint --strict on each tarball when asked, and fails when it does", async ({
    onTestFinished,
  }) => {
    const dir = await packDir([COMPLETE]);
    const bin = await mkdtemp(join(tmpdir(), "fake-publint-"));
    onTestFinished(() =>
      Promise.all([dir, bin].map((path) => rm(path, { recursive: true, force: true }))),
    );
    const log = join(bin, "calls");
    const publint = join(bin, "publint");
    await writeFile(
      publint,
      `#!/bin/sh\necho "$@" >> "${log}"\n[ -f "${join(bin, "fail")}" ] && { echo "pkg.exports is wrong"; exit 1; }\nexit 0\n`,
    );
    await chmod(publint, 0o755);

    await expect(run([dir, "--publint", publint])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("and publint passes"),
    });
    expect(await readFile(log, "utf8")).toBe(
      `run ${join(dir, "hussmartinez-sdk-core-0.3.0.tgz")} --strict\n`,
    );

    await writeFile(join(bin, "fail"), "");
    const failed = await run(["--publint", publint, dir]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("publint --strict failed:\npkg.exports is wrong");
  });

  it("says when there's nothing to check", async ({ onTestFinished }) => {
    const dir = await packDir([]);
    onTestFinished(() => rm(dir, { recursive: true, force: true }));

    await expect(run([dir])).resolves.toMatchObject({ code: 0, stdout: "No tarballs to check.\n" });
  });

  it("exits 2 without a pack directory, or without publint's command", async () => {
    await expect(run([])).resolves.toMatchObject({ code: 2 });
    await expect(run(["dir", "--publint"])).resolves.toMatchObject({ code: 2 });
  });
});

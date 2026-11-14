// Tests of the composite actions themselves: the scripts written inline in
// their action.yml, the shared plan script, and the structure that the
// release's safety depends on.
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACTIONS = ["image", "verify", "version", "plan", "publish"];

/** A GitHub Actions expression, `${{ … }}`, as it appears in action.yml. */
const expression = (/** @type {string} */ body) => `$${"{{"} ${body} }}`;

/** @param {string} name */
async function action(name) {
  return parse(await readFile(join(ROOT, name, "action.yml"), "utf8"));
}

/** @param {string} name @param {string} step */
async function script(name, step) {
  const { runs } = await action(name);
  const found = runs.steps.find((candidate) => candidate.name === step);
  if (!found?.run) {
    throw new Error(`${name} has no "${step}" step with a script`);
  }
  return found.run;
}

/**
 * Runs a bash script in a fresh directory with these files, and returns its
 * exit code, the outputs it wrote and its output.
 *
 * @param {string} body
 * @param {Record<string, string>} files
 * @param {Record<string, string>} [env]
 */
async function bash(body, files, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hm-sdk-ci-action-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    const output = join(dir, "github-output");
    await writeFile(output, "");
    let code = 0;
    let stdout = "";
    try {
      stdout = execFileSync("bash", ["-e", "-c", body], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: dir, ...env },
        stdio: "pipe",
      });
    } catch (error) {
      code = /** @type {{ status?: number }} */ (error).status ?? 1;
      stdout = String(/** @type {{ stdout?: unknown }} */ (error).stdout ?? "");
    }
    return { code, outputs: await readFile(output, "utf8"), stdout };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.each(ACTIONS)("the %s action", (name) => {
  it("is a composite action with a description", async () => {
    const definition = await action(name);
    expect(definition.runs.using).toBe("composite");
    expect(definition.description).toEqual(expect.any(String));
  });

  it("declares every input it uses", async () => {
    const text = await readFile(join(ROOT, name, "action.yml"), "utf8");
    const declared = Object.keys((await action(name)).inputs ?? {});
    const used = [...text.matchAll(/inputs\.([\w-]+)/g)].map((match) => match[1]);
    for (const input of used) {
      expect(declared, `${name} uses inputs.${input}`).toContain(input);
    }
  });

  it("only runs files that exist next to it", async () => {
    const text = await readFile(join(ROOT, name, "action.yml"), "utf8");
    const paths = [
      ...text.matchAll(/(?:\$GITHUB_ACTION_PATH|\$\{\{ github\.action_path \}\})\/([\w./-]+)/g),
    ].map((match) => match[1] ?? "");
    for (const path of paths) {
      await expect(access(resolve(ROOT, name, path)), `${name}: ${path}`).resolves.toBeUndefined();
    }
  });
});

describe("the image action's validation", () => {
  const DIGEST = "a".repeat(64);
  const VALID = `mcr.microsoft.com/playwright:v1.65.0-noble@sha256:${DIGEST}`;
  const read = async (dockerfile) =>
    bash(
      await script("image", "Read the image"),
      { "ci/Dockerfile": dockerfile },
      {
        DOCKERFILE: "ci/Dockerfile",
      },
    );

  it("outputs exactly one pinned Playwright FROM line", async () => {
    await expect(read(`# A comment\nFROM ${VALID}\n`)).resolves.toMatchObject({
      code: 0,
      outputs: `ref=${VALID}\n`,
    });
  });

  it.each([
    ["no FROM line", "# nothing here\n"],
    ["two FROM lines", `FROM ${VALID}\nFROM ${VALID}\n`],
    ["a tag without a digest", "FROM mcr.microsoft.com/playwright:v1.65.0-noble\n"],
    ["a digest without a tag", `FROM mcr.microsoft.com/playwright@sha256:${DIGEST}\n`],
    ["another registry", `FROM docker.io/playwright:v1.65.0-noble@sha256:${DIGEST}\n`],
    ["another base", `FROM mcr.microsoft.com/playwright:v1.65.0-jammy@sha256:${DIGEST}\n`],
    ["a short digest", "FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:abc\n"],
    ["trailing text", `FROM ${VALID} AS base\n`],
  ])("rejects %s", async (_, dockerfile) => {
    await expect(read(dockerfile)).resolves.toMatchObject({ code: 1, outputs: "" });
  });
});

describe("the shared plan script", () => {
  /**
   * Runs plan.sh with a fake pnpm whose publish plan has these steps.
   *
   * @param {Array<{ kind: string }>} steps
   */
  async function plan(steps) {
    const bin = await mkdtemp(join(tmpdir(), "hm-sdk-ci-bin-"));
    try {
      // `pnpm changeset publish-plan --output <file>` writes the plan.
      await writeFile(
        join(bin, "pnpm"),
        `#!/bin/sh\n[ "$1 $2 $3" = "changeset publish-plan --output" ] || exit 2\nprintf '%s' '${JSON.stringify({ plan: [steps] })}' > "$4"\n`,
      );
      await chmod(join(bin, "pnpm"), 0o755);
      return await bash(
        join(ROOT, "plan", "plan.sh"),
        {},
        { PATH: `${bin}:${process.env["PATH"]}` },
      );
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  }

  it("is pending when there are versions to publish", async () => {
    await expect(plan([{ kind: "publish" }, { kind: "publish" }])).resolves.toMatchObject({
      code: 0,
      outputs: "pending=true\n",
      stdout: "Versions to publish: 2\n",
    });
  });

  it("isn't pending when every version is on npm", async () => {
    await expect(plan([{ kind: "skip" }])).resolves.toMatchObject({
      code: 0,
      outputs: "pending=false\n",
    });
  });
});

describe("the publish action", () => {
  /** @param {(step: Record<string, any>) => boolean} test */
  const index = async (test) => (await action("publish")).runs.steps.findIndex(test);

  it("checks the release was verified, then downloads and checks its tarballs, before publishing", async () => {
    const check = await index((step) => step.name === "Check that this release was verified");
    const download = await index((step) => step.name === "Download the verified tarballs");
    const tarballs = await index((step) => step.name === "Check the verified tarballs");
    const publish = await index((step) => String(step.uses).startsWith("changesets/action@"));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(download);
    expect(download).toBeLessThan(tarballs);
    expect(tarballs).toBeLessThan(publish);
    const { runs } = await action("publish");
    expect(runs.steps[check].env).toEqual({ VERIFIED: `${expression("inputs.verified")}` });
    // Every step that publishes runs only after the earlier steps succeeded.
    for (const step of runs.steps.slice(check, publish + 1)) {
      expect(step.if).toBe("steps.plan.outputs.pending == 'true'");
    }
  });

  it("never builds or packs: it publishes the verify job's tarballs", async () => {
    const { runs } = await action("publish");
    const text = await readFile(join(ROOT, "publish", "action.yml"), "utf8");
    expect(text).not.toMatch(/changeset pack|pnpm build|pnpm -r build|pnpm verify/);
    const download = runs.steps.find((step) => step.name === "Download the verified tarballs");
    expect(download.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
    expect(download.with).toEqual({
      name: "release-packs",
      path: `${expression("runner.temp")}/release-packs`,
    });
    const check = runs.steps.find((step) => step.name === "Check the verified tarballs");
    expect(check.env).toEqual({ PACKS: expression("inputs.packs") });
    expect(check.run).toContain('node "$GITHUB_ACTION_PATH/check-tarballs.mjs" "$packs"');
    expect(check.run).not.toContain("--publint");
  });

  describe("its check of the verified tarballs", () => {
    /** @param {Array<[string, string]>} versions */
    const planOf = (versions) =>
      JSON.stringify({
        plan: [versions.map(([name, version]) => ({ kind: "publish", name, version }))],
      });
    const sha256 = (/** @type {string} */ text) =>
      execFileSync("sha256sum", { input: text, encoding: "utf8" }).split(" ")[0];

    /** @param {string} downloaded @param {string} planned @param {string} packs */
    async function check(downloaded, planned, packs) {
      return bash(
        await script("publish", "Check the verified tarballs"),
        { "release-packs/publish-plan.json": downloaded, "publish-plan.json": planned },
        { PACKS: packs, GITHUB_ACTION_PATH: join(ROOT, "publish") },
      );
    }

    it("passes the verify job's plan for the same versions, in any order", async () => {
      const downloaded = JSON.stringify({ plan: [] });
      await expect(check(downloaded, planOf([]), sha256(downloaded))).resolves.toMatchObject({
        code: 0,
        stdout: expect.stringContaining("No tarballs to check."),
      });
      const both = planOf([
        ["b", "1.0.0"],
        ["a", "2.0.0"],
      ]);
      const reordered = planOf([
        ["a", "2.0.0"],
        ["b", "1.0.0"],
      ]);
      // The plan's steps have no tarballs, so the file check fails after the
      // hash and plan checks pass: proof that they passed.
      await expect(check(both, reordered, sha256(both))).resolves.toMatchObject({ code: 1 });
    });

    it("refuses a plan that isn't the one the verify job recorded", async () => {
      const downloaded = planOf([["a", "1.0.0"]]);
      for (const packs of ["", sha256(`${downloaded} `), "0".repeat(64)]) {
        const result = await check(downloaded, downloaded, packs);
        expect(result).toMatchObject({ code: 1 });
        expect(result.stdout).toContain("title=Unverified tarballs");
      }
    });

    it("refuses tarballs for other versions than this job plans", async () => {
      const downloaded = planOf([["a", "1.0.0"]]);
      const result = await check(downloaded, planOf([["a", "1.0.1"]]), sha256(downloaded));
      expect(result).toMatchObject({ code: 1 });
      expect(result.stdout).toContain("title=Different release");
    });
  });

  it("refuses an unverified release in its check", async () => {
    const check = await script("publish", "Check that this release was verified");
    for (const result of ["failure", "skipped", "cancelled", ""]) {
      await expect(bash(check, {}, { VERIFIED: result })).resolves.toMatchObject({ code: 1 });
    }
    await expect(bash(check, {}, { VERIFIED: "success" })).resolves.toMatchObject({ code: 0 });
  });

  it("finishes releases even after a failure, but never after a cancellation", async () => {
    const { runs } = await action("publish");
    const finishing = runs.steps.slice(runs.steps.findIndex((step) => step.id === "finish"));
    expect(finishing).toHaveLength(3);
    for (const step of finishing) {
      expect(step.if).toMatch(/^\$\{\{ !cancelled\(\) && /);
    }
  });

  it("installs no browsers, and runs no tests, where the OIDC token is", async () => {
    const text = await readFile(join(ROOT, "publish", "action.yml"), "utf8");
    expect(text).not.toMatch(/playwright|pnpm verify|pnpm test/);
  });

  it("passes the publish command and the record to the publish script", async () => {
    const { runs } = await action("publish");
    const publish = runs.steps.find((step) => String(step.uses).startsWith("changesets/action@"));
    expect(publish.env).toEqual({
      PUBLISHED_RECORD: `${expression("runner.temp")}/published.ndjson`,
      NPM_PUBLISH_COMMAND: `${expression("inputs.npm-publish-command")}`,
    });
    expect(publish.with["publish-script"]).toBe(
      `node ${expression("github.action_path")}/publish-packages.mjs ${expression("runner.temp")}/release-packs`,
    );
  });
});

describe("the verify action", () => {
  it("caches pnpm's store only when asked to", async () => {
    const { runs, inputs } = await action("verify");
    const setup = runs.steps.find((step) => String(step.uses).startsWith("pnpm/action-setup@"));
    expect(setup.with).toEqual({ cache: `${expression("inputs.cache == 'true'")}` });
    expect(inputs.cache.default).toBe("true");
  });

  it("refuses to pack a release with a cached store", async () => {
    const check = await script("verify", "Check the inputs");
    await expect(bash(check, {}, { CACHE: "true", PACK: "true" })).resolves.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("title=Cached release"),
    });
    for (const [cache, pack] of [
      ["false", "true"],
      ["true", "false"],
      ["false", "false"],
    ]) {
      await expect(bash(check, {}, { CACHE: cache, PACK: pack })).resolves.toMatchObject({
        code: 0,
      });
    }
  });

  it("fails up front, naming it, when the image lacks a tool the pack path needs", async () => {
    const check = await script("verify", "Check the inputs");
    // A PATH with bash and the tools the pack path needs, except tar.
    const bin = await mkdtemp(join(tmpdir(), "hm-sdk-ci-tools-"));
    try {
      for (const tool of ["bash", "sha256sum", "cut", "gzip"]) {
        const path = execFileSync("bash", ["-c", `command -v ${tool}`], {
          encoding: "utf8",
        }).trim();
        await writeFile(join(bin, tool), `#!/bin/sh\nexec ${path} "$@"\n`);
        await chmod(join(bin, tool), 0o755);
      }
      await expect(
        bash(check, {}, { CACHE: "false", PACK: "true", PATH: bin }),
      ).resolves.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("title=Missing tool::pack needs tar"),
      });
      // Without pack, nothing is required of the image.
      await expect(
        bash(check, {}, { CACHE: "true", PACK: "false", PATH: bin }),
      ).resolves.toMatchObject({
        code: 0,
      });
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("packs, checks and uploads only with pack, after pnpm verify has built and verified", async () => {
    const { runs, inputs, outputs } = await action("verify");
    expect(inputs.pack.default).toBe("false");
    const at = (/** @type {(step: Record<string, any>) => boolean} */ test) =>
      runs.steps.findIndex(test);
    const verify = at((step) => step.run === "pnpm verify");
    const pack = at((step) => step.name === "Pack the packages");
    const check = at((step) => step.name === "Check the tarballs");
    const hash = at((step) => step.id === "packs");
    const upload = at((step) => String(step.uses).startsWith("actions/upload-artifact@"));
    expect([verify, pack, check, hash, upload]).toEqual(
      [verify, pack, check, hash, upload].toSorted((a, b) => a - b),
    );
    expect(verify).toBeGreaterThan(-1);
    for (const step of runs.steps.slice(pack, upload + 1)) {
      expect(step.if).toBe("inputs.pack == 'true' && steps.plan.outputs.pending == 'true'");
    }
    expect(runs.steps[check].run).toContain(
      'check-tarballs.mjs" "$RUNNER_TEMP/release-packs" --publint "$work/node_modules/.bin/publint"',
    );
    expect(runs.steps[check].run).toContain("npm ci --ignore-scripts");
    expect(runs.steps[upload].uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(runs.steps[upload].with).toMatchObject({
      name: "release-packs",
      path: `${expression("runner.temp")}/release-packs`,
      "if-no-files-found": "error",
    });
    expect(outputs.packs.value).toBe(expression("steps.packs.outputs.sha256"));
  });

  it("uploads the test results when any step fails, and only then", async () => {
    const { runs, inputs } = await action("verify");
    const last = runs.steps.at(-1);
    expect(last.name).toBe("Upload the test results");
    expect(last.if).toBe("failure()");
    expect(last.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(last.with).toEqual({
      name: "test-results",
      path: expression("inputs.results"),
      "if-no-files-found": "ignore",
      "include-hidden-files": true,
      "retention-days": 7,
    });
    // Playwright's results, including the visual tests' diffs (ADR 0048, in
    // sdk-core), and Vitest's attachments, but nothing from node_modules.
    expect(inputs.results.default.trim().split("\n")).toEqual([
      "**/test-results/",
      "**/.vitest/attachments/",
      "!**/node_modules/**",
    ]);
  });

  it("locks the publint it runs", async () => {
    const lock = JSON.parse(
      await readFile(join(ROOT, "verify", "publint", "package-lock.json"), "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(join(ROOT, "verify", "publint", "package.json"), "utf8"),
    );
    expect(manifest.dependencies.publint).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages["node_modules/publint"].version).toBe(manifest.dependencies.publint);
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path !== "") {
        expect(entry.integrity, path).toMatch(/^sha512-/);
      }
    }
  });
});

describe("the action_path fixture", () => {
  // CI runs the fixture to prove that github.action_path works inside a
  // nested action's with:, as the publish action relies on. It only proves
  // that while it has the same shape.
  it("has the same shape as the publish action's publishing step", async () => {
    const nested = (definition) =>
      definition.runs.steps.find((step) => String(step.uses).startsWith("changesets/action@"));
    const publish = nested(await action("publish"));
    const fixture = nested(
      parse(await readFile(join(ROOT, "test", "fixtures", "action-path", "action.yml"), "utf8")),
    );
    const prefix = `node ${expression("github.action_path")}/`;

    expect(fixture.uses).toBe(publish.uses);
    expect(publish.with["publish-script"].startsWith(prefix)).toBe(true);
    expect(fixture.with["publish-script"].startsWith(prefix)).toBe(true);
  });
});

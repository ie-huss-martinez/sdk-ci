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

  it("checks that the release was verified before anything is packed or published", async () => {
    const check = await index((step) => step.name === "Check that this release was verified");
    const pack = await index((step) => step.name === "Pack the packages");
    const publish = await index((step) => String(step.uses).startsWith("changesets/action@"));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(pack);
    expect(pack).toBeLessThan(publish);
    const { runs } = await action("publish");
    expect(runs.steps[check].env).toEqual({ VERIFIED: `${expression("inputs.verified")}` });
    // Every step that publishes runs only after the earlier steps succeeded.
    for (const step of runs.steps.slice(check, publish + 1)) {
      expect(step.if).toBe("steps.plan.outputs.pending == 'true'");
    }
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
});

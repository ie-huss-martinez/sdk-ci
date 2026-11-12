import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKELETON = join(ROOT, "skeleton");
const CHECK = join(ROOT, "check-workflows", "check-workflows.mjs");

const PLACEHOLDER = "0000000000000000000000000000000000000000 # vX.Y.Z";
const SHA = "1".repeat(40);
const PIN = `${SHA} # v1.2.3`;

/** The skeleton's workflows, as a repository pinning sdk-ci v1.2.3 has them. */
async function pinned() {
  const files = {};
  for (const name of await readdir(SKELETON)) {
    files[name] = (await readFile(join(SKELETON, name), "utf8")).replaceAll(PLACEHOLDER, PIN);
  }
  return files;
}

/**
 * Writes these workflows to a temporary directory, runs the check's real
 * command line on it, and returns its exit code and output.
 *
 * @param {Record<string, string>} files
 * @param {(fn: () => Promise<void>) => void} onTestFinished
 */
async function check(files, onTestFinished) {
  const dir = await mkdtemp(join(tmpdir(), "hm-check-workflows-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return /** @type {Promise<{ code: number, stdout: string }>} */ (
    new Promise((resolve) => {
      execFile(process.execPath, [CHECK, SKELETON, dir], { encoding: "utf8" }, (error, stdout) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout });
      });
    })
  );
}

/**
 * Changes one workflow of a pinned copy.
 *
 * @param {string} name
 * @param {(text: string) => string} change
 */
async function changed(name, change) {
  const files = await pinned();
  const before = files[name];
  files[name] = change(before);
  expect(files[name], "the change must apply").not.toBe(before);
  return files;
}

describe.concurrent("check-workflows", () => {
  it("accepts the skeleton pinned to one sdk-ci version", async ({ onTestFinished }) => {
    const run = await check(await pinned(), onTestFinished);

    expect(run.stdout).toBe(
      `The workflows match sdk-ci's skeleton (3 files, sdk-ci ${SHA} # v1.2.3).\n`,
    );
    expect(run.code).toBe(0);
  });

  it("allows a repository's own jobs, workflows and environment variables", async ({
    onTestFinished,
  }) => {
    const files = await changed("verify.yml", (text) =>
      text
        .replace('      HUSKY: "0"\n', '      HUSKY: "0"\n      HM_VISUAL_CONTAINER: "1"\n')
        .concat(
          "\n  e2e:\n    name: e2e\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm test:e2e\n",
        ),
    );
    files["docs.yml"] = "name: Docs\non: push\njobs: {}\n";

    expect((await check(files, onTestFinished)).code).toBe(0);
  });

  it("ignores formatting: key order, quoting and a single need written as a list", async ({
    onTestFinished,
  }) => {
    const files = await changed("verify.yml", (text) =>
      text
        .replace("    needs: image\n", "    needs: [image]\n")
        .replace(
          "    runs-on: ubuntu-latest\n    timeout-minutes: 15\n",
          "    timeout-minutes: 15\n    runs-on: 'ubuntu-latest'\n",
        ),
    );

    expect((await check(files, onTestFinished)).code).toBe(0);
  });

  it.for([
    [
      "a missing workflow",
      async () => {
        const files = await pinned();
        delete files["pr-title.yml"];
        return files;
      },
      "pr-title.yml: is missing",
    ],
    [
      "a missing job",
      () => changed("verify.yml", (text) => text.replace(/\n {2}changeset:\n[\s\S]*$/, "\n")),
      "job `changeset` is missing",
    ],
    [
      "wider permissions",
      () =>
        changed("release.yml", (text) =>
          text.replace(
            "    permissions:\n      contents: read\n    outputs:\n      pending:",
            "    permissions:\n      contents: write\n    outputs:\n      pending:",
          ),
        ),
      "job `plan`: `permissions`",
    ],
    [
      "a verify job that a failed image job would skip",
      () => changed("verify.yml", (text) => text.replace(`    if: $${"{{"} !cancelled() }}\n`, "")),
      "job `verify`: `if` is nothing",
    ],
    [
      "an extra step where the OIDC token is",
      () =>
        changed("release.yml", (text) =>
          text.replace(
            `      - uses: ie-huss-martinez/sdk-ci/publish@${PIN}`,
            `      - run: pnpm test\n      - uses: ie-huss-martinez/sdk-ci/publish@${PIN}`,
          ),
        ),
      "job `publish`: `steps`",
    ],
    [
      "another environment",
      () =>
        changed("release.yml", (text) =>
          text.replace("    environment: npm\n", "    environment: production\n"),
        ),
      "job `publish`: `environment`",
    ],
    [
      "a removed environment variable",
      () =>
        changed("verify.yml", (text) => text.replace('      HUSKY: "0"\n', '      CI: "true"\n')),
      "job `verify`: env `HUSKY` is nothing",
    ],
    [
      "two sdk-ci versions",
      () =>
        changed("release.yml", (text) =>
          text.replace(`sdk-ci/plan@${PIN}`, `sdk-ci/plan@${"2".repeat(40)} # v1.2.4`),
        ),
      "sdk-ci is pinned to more than one version",
    ],
    [
      "a tag instead of a SHA",
      () => changed("pr-title.yml", (text) => text.replace(`pr-title@${PIN}`, "pr-title@v1.2.3")),
      'must be pinned to a full commit SHA, not "v1.2.3"',
    ],
    [
      "a SHA without its version",
      () => changed("pr-title.yml", (text) => text.replace(`pr-title@${PIN}`, `pr-title@${SHA}`)),
      'needs its version in a "# vX.Y.Z" comment',
    ],
  ])("rejects %s", async ([, make, message], { onTestFinished }) => {
    const run = await check(await make(), onTestFinished);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(message);
    expect(run.stdout).toContain("::error file=");
  });
});

describe("the skeleton", () => {
  /** Every sdk-ci step in the skeleton, with its action's definition. */
  async function steps() {
    const found = [];
    for (const name of await readdir(SKELETON)) {
      const workflow = parse(await readFile(join(SKELETON, name), "utf8"));
      for (const [id, job] of Object.entries(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          const action = /^ie-huss-martinez\/sdk-ci\/([\w-]+)@/.exec(step.uses ?? "")?.[1];
          if (action) {
            found.push({ where: `${name} ${id}`, action, step });
          }
        }
      }
    }
    return found;
  }

  it("only uses actions this repository has, with inputs they declare", async () => {
    for (const { where, action, step } of await steps()) {
      const file = join(ROOT, action, "action.yml");
      await expect(access(file), `${where}: ${action}`).resolves.toBeUndefined();
      const inputs = parse(await readFile(file, "utf8")).inputs ?? {};
      for (const input of Object.keys(step.with ?? {})) {
        expect(Object.keys(inputs), `${where}: ${action} has no input ${input}`).toContain(input);
      }
      for (const [input, definition] of Object.entries(inputs)) {
        if (definition.required) {
          expect(step.with ?? {}, `${where}: ${action} needs ${input}`).toHaveProperty(input);
        }
      }
    }
  });

  it("calls every action except check-workflows' own dependencies", async () => {
    const used = new Set((await steps()).map(({ action }) => action));
    for (const action of [
      "pr-title",
      "image",
      "verify",
      "check-workflows",
      "changeset",
      "version",
      "plan",
      "publish",
    ]) {
      expect(used, action).toContain(action);
    }
  });

  it("pins every sdk-ci step to the placeholder that check-workflows ignores", async () => {
    for (const name of await readdir(SKELETON)) {
      const text = await readFile(join(SKELETON, name), "utf8");
      for (const line of text.split("\n").filter((entry) => entry.includes("sdk-ci/"))) {
        expect(line, name).toContain(`@${PLACEHOLDER}`);
      }
    }
  });
});

describe("the check-workflows action", () => {
  it("installs the same yaml version the tests use", async () => {
    const lock = JSON.parse(
      await readFile(join(ROOT, "check-workflows", "package-lock.json"), "utf8"),
    );
    const installed = createRequire(import.meta.url)("yaml/package.json").version;
    expect(lock.packages["node_modules/yaml"].version).toBe(installed);
    expect(lock.packages["node_modules/yaml"].integrity).toMatch(/^sha512-/);
  });
});

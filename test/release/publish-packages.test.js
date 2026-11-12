import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox, integrityOf, SCRIPTS, tarballName } from "./harness.js";

const CORE = { name: "@hussmartinez/sdk-core", version: "1.0.0", dir: "a-core" };
const CONFIG = { name: "@hussmartinez/sdk-config", version: "2.0.0", dir: "b-config" };

/**
 * A sandbox with what `changeset pack` leaves in the pack directory: a
 * tarball per package and a publish plan with each tarball's integrity.
 * `tamper` names packages whose tarball changes after the plan was written.
 *
 * The sandbox is removed when the test finishes.
 *
 * @param {(fn: () => Promise<void>) => void} onTestFinished
 * @param {{ tamper?: string[] }} [options]
 */
async function packed(onTestFinished, { tamper = [] } = {}) {
  const box = await createSandbox([CORE, CONFIG]);
  onTestFinished(() => box.close());
  const packDir = join(box.temp, "release-packs");
  await mkdir(packDir);
  /** @type {Record<string, Buffer>} */
  const bytes = {};
  const steps = [];
  for (const pkg of [CORE, CONFIG]) {
    const tarball = await box.tarball(pkg.name, pkg.version, packDir);
    bytes[pkg.name] = tarball.bytes;
    steps.push({
      kind: "publish",
      name: pkg.name,
      version: pkg.version,
      access: "public",
      tag: "latest",
      tarball: {
        path: tarballName(pkg.name, pkg.version),
        integrity: integrityOf(tarball.bytes, "sha256"),
      },
    });
    if (tamper.includes(pkg.name)) {
      await writeFile(tarball.path, Buffer.concat([tarball.bytes, Buffer.from("tampered")]));
    }
  }
  await writeFile(join(packDir, "publish-plan.json"), JSON.stringify({ plan: [steps] }));
  const files = {
    record: join(box.temp, "published.ndjson"),
    changesets: join(box.temp, "changesets-output"),
  };
  return { box, packDir, bytes, files };
}

/** @param {Awaited<ReturnType<typeof packed>>} setup @param {Record<string, string>} [env] */
const publish = ({ box, packDir, files }, env = {}) =>
  box.run(SCRIPTS.publish, [packDir], {
    PUBLISHED_RECORD: files.record,
    CHANGESETS_OUTPUT: files.changesets,
    ...env,
  });

/** @param {string} path */
const lines = async (path) =>
  (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** The annotated tags in the workspace. @param {Awaited<ReturnType<typeof createSandbox>>} box */
const tags = (box) =>
  execFileSync("git", ["for-each-ref", "--format=%(objecttype) %(refname:short)", "refs/tags"], {
    cwd: box.workspace,
    env: box.gitEnv,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

describe.concurrent("publish-packages", () => {
  it("publishes each tarball with provenance, records it, tags it and reports the tag", async ({
    onTestFinished,
  }) => {
    const setup = await packed(onTestFinished);
    const before = Date.now();

    const run = await publish(setup);

    expect(run.code, run.stderr).toBe(0);
    const npm = (await setup.box.calls()).filter((call) => call.tool === "npm");
    expect(npm.map((call) => call.args)).toEqual(
      [CORE, CONFIG].map((pkg) => [
        "publish",
        join(setup.packDir, tarballName(pkg.name, pkg.version)),
        "--provenance",
        "--access",
        "public",
        "--tag",
        "latest",
      ]),
    );
    const recorded = await lines(setup.files.record);
    expect(recorded.map(({ name, version }) => `${name}@${version}`)).toEqual([
      "@hussmartinez/sdk-core@1.0.0",
      "@hussmartinez/sdk-config@2.0.0",
    ]);
    for (const entry of recorded) {
      expect(entry.tarball).toBe(join(setup.packDir, tarballName(entry.name, entry.version)));
      expect(entry.publishedAt).toBeGreaterThanOrEqual(before);
      expect(entry.publishedAt).toBeLessThanOrEqual(Date.now());
    }
    expect(tags(setup.box).sort()).toEqual([
      "tag @hussmartinez/sdk-config@2.0.0",
      "tag @hussmartinez/sdk-core@1.0.0",
    ]);
    expect(await lines(setup.files.changesets)).toEqual([
      { type: "git-tag", tag: "@hussmartinez/sdk-core@1.0.0", packageName: CORE.name },
      { type: "git-tag", tag: "@hussmartinez/sdk-config@2.0.0", packageName: CONFIG.name },
    ]);
  });

  it("uses `npm stage publish` when NPM_PUBLISH_COMMAND asks for it", async ({
    onTestFinished,
  }) => {
    const setup = await packed(onTestFinished);

    const run = await publish(setup, { NPM_PUBLISH_COMMAND: "stage publish" });

    expect(run.code, run.stderr).toBe(0);
    const npm = (await setup.box.calls()).filter((call) => call.tool === "npm");
    expect(npm.map((call) => call.args.slice(0, 2))).toEqual([
      ["stage", "publish"],
      ["stage", "publish"],
    ]);
  });

  it("refuses a tarball that doesn't match the plan, and still publishes the others", async ({
    onTestFinished,
  }) => {
    const setup = await packed(onTestFinished, { tamper: [CORE.name] });

    const run = await publish(setup);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Failed to publish @hussmartinez/sdk-core@1.0.0: ");
    expect(run.stderr).toContain("doesn't match the plan's integrity");
    const npm = (await setup.box.calls()).filter((call) => call.tool === "npm");
    expect(npm.map((call) => call.args[1])).toEqual([
      join(setup.packDir, tarballName(CONFIG.name, CONFIG.version)),
    ]);
    expect(tags(setup.box)).toEqual(["tag @hussmartinez/sdk-config@2.0.0"]);
  });

  it("finishes the package that published when another fails", async ({ onTestFinished }) => {
    const setup = await packed(onTestFinished);
    const { box } = setup;
    await box.failPublish(tarballName(CONFIG.name, CONFIG.version));

    const run = await publish(setup);

    // sdk-core is published, recorded, tagged and reported; sdk-config isn't.
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Failed to publish @hussmartinez/sdk-config@2.0.0");
    expect(run.stdout).toContain("Published @hussmartinez/sdk-core@1.0.0");
    expect((await lines(setup.files.record)).map((entry) => entry.name)).toEqual([CORE.name]);
    expect(tags(box)).toEqual(["tag @hussmartinez/sdk-core@1.0.0"]);
    expect((await lines(setup.files.changesets)).map((entry) => entry.tag)).toEqual([
      "@hussmartinez/sdk-core@1.0.0",
    ]);

    // The finishing step, as the workflow runs it after the failed publish:
    // changesets/action has created sdk-core's release, and npm serves it.
    await box.onNpm(CORE.name, CORE.version, setup.bytes[CORE.name] ?? Buffer.alloc(0));
    await box.release("@hussmartinez/sdk-core@1.0.0");
    const assets = join(box.temp, "release-assets");
    const finish = await box.run(SCRIPTS.finish, ["prepare", assets], {
      PUBLISHED_RECORD: setup.files.record,
      PUBLISH_PLAN: join(setup.packDir, "publish-plan.json"),
    });

    expect(finish.code, finish.stderr).toBe(0);
    expect(finish.stdout).toContain(
      "@hussmartinez/sdk-core@1.0.0: attaching missing files (this run's tarball).",
    );
    expect(finish.stdout).toContain(
      "::warning title=Not on npm::@hussmartinez/sdk-config@2.0.0: this run planned to publish it, but it isn't on npm.",
    );
    expect(finish.output).toBe("count=1\n");

    const attached = await box.run(SCRIPTS.finish, ["attach", assets]);

    expect(attached.code, attached.stderr).toBe(0);
    expect((await box.github()).releases["@hussmartinez/sdk-core@1.0.0"]?.assets).toEqual([
      tarballName(CORE.name, CORE.version),
      "SHA256SUMS",
    ]);
  });
});

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox, SCRIPTS, TIMING, tarballName } from "./harness.js";

const CORE = { name: "@hussmartinez/sdk-core", version: "1.0.0", dir: "a-core" };
const CONFIG = { name: "@hussmartinez/sdk-config", version: "2.0.0", dir: "b-config" };
const CORE_TAG = `${CORE.name}@${CORE.version}`;
const CONFIG_TAG = `${CONFIG.name}@${CONFIG.version}`;
const CORE_FILE = tarballName(CORE.name, CORE.version);
const CONFIG_FILE = tarballName(CONFIG.name, CONFIG.version);

/**
 * Creates a sandbox that's removed when the test finishes. Tests run
 * concurrently, so each cleans up only its own.
 *
 * @param {(fn: () => Promise<void>) => void} onTestFinished
 * @param {Parameters<typeof createSandbox>[0]} [packages]
 */
async function sandbox(onTestFinished, packages = [CORE, CONFIG]) {
  const created = await createSandbox(packages);
  onTestFinished(() => created.close());
  return created;
}

/**
 * Writes the record publish-packages leaves for the versions this run
 * published, and returns its path.
 *
 * @param {Awaited<ReturnType<typeof createSandbox>>} box
 * @param {Array<{ name: string, version: string, tarball: string, publishedAt: number }>} entries
 */
async function record(box, entries) {
  const path = join(box.temp, "published.ndjson");
  await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return path;
}

/**
 * Writes a publish plan listing these versions, and returns its path.
 *
 * @param {Awaited<ReturnType<typeof createSandbox>>} box
 * @param {Array<{ name: string, version: string }>} versions
 */
async function plan(box, versions) {
  const path = join(box.temp, "publish-plan.json");
  const steps = versions.map((version) => ({ kind: "publish", ...version }));
  await writeFile(path, JSON.stringify({ plan: [steps] }));
  return path;
}

/** @param {Awaited<ReturnType<typeof createSandbox>>} box */
const assetsDir = (box) => join(box.temp, "release-assets");

/** The files prepared for each release, by directory. @param {Awaited<ReturnType<typeof createSandbox>>} box */
async function prepared(box) {
  const dirs = await readdir(assetsDir(box)).catch(() => []);
  return Object.fromEntries(
    await Promise.all(
      dirs.map(async (dir) => [dir, (await readdir(join(assetsDir(box), dir))).sort()]),
    ),
  );
}

/** @param {Awaited<ReturnType<typeof createSandbox>>} box @param {Record<string, string>} [env] */
const prepare = (box, env) => box.run(SCRIPTS.finish, ["prepare", assetsDir(box)], env);

/** @param {Awaited<ReturnType<typeof createSandbox>>} box */
const attach = (box) => box.run(SCRIPTS.finish, ["attach", assetsDir(box)]);

const sha256 = (/** @type {Buffer} */ bytes) => createHash("sha256").update(bytes).digest("hex");

describe.concurrent("finish-releases prepare", () => {
  it("waits for a version this run published, then finishes it with this run's tarball", async ({
    onTestFinished,
  }) => {
    const box = await sandbox(onTestFinished);
    const { path, bytes } = await box.tarball(CORE.name, CORE.version);
    await box.onNpm(CORE.name, CORE.version, bytes, { visibleAfter: 3 });
    await box.release(CORE_TAG);
    const published = await record(box, [{ ...CORE, tarball: path, publishedAt: Date.now() }]);

    const run = await prepare(box, { PUBLISHED_RECORD: published });

    expect(run.code, run.stderr).toBe(0);
    expect(box.polls(CORE.name, CORE.version)).toHaveLength(4);
    expect(run.stdout).toMatch(
      /::notice title=Visible on npm::@hussmartinez\/sdk-core@1\.0\.0: visible on npm \d+ s after its publish\./,
    );
    expect(run.output).toBe("count=1\n");
    const dir = join(assetsDir(box), "hussmartinez__sdk-core@1.0.0");
    expect(await readFile(join(dir, CORE_FILE))).toEqual(bytes);
    expect(await readFile(join(dir, "SHA256SUMS"), "utf8")).toBe(
      `${sha256(bytes)}  ./${CORE_FILE}\n`,
    );
    expect(JSON.parse(await readFile(join(dir, "release.json"), "utf8"))).toMatchObject({
      tag: CORE_TAG,
      file: CORE_FILE,
      needsRelease: false,
    });
    // This run's tarball, not a download.
    expect((await box.calls()).filter((call) => call.tool === "npm")).toEqual([]);
  });

  it("logs the delay even when a version is visible straight away", async ({ onTestFinished }) => {
    const box = await sandbox(onTestFinished);
    const { path, bytes } = await box.tarball(CORE.name, CORE.version);
    await box.onNpm(CORE.name, CORE.version, bytes);
    await box.release(CORE_TAG);
    const published = await record(box, [{ ...CORE, tarball: path, publishedAt: Date.now() }]);

    const run = await prepare(box, { PUBLISHED_RECORD: published });

    expect(run.code, run.stderr).toBe(0);
    expect(box.polls(CORE.name, CORE.version)).toHaveLength(1);
    // The time from the record to the first check, which depends on load.
    expect(run.stdout).toMatch(
      /::notice title=Visible on npm::@hussmartinez\/sdk-core@1\.0\.0: visible on npm \d+ s after its publish\./,
    );
  });

  it("fails loudly when a version this run published never becomes visible", async ({
    onTestFinished,
  }) => {
    const box = await sandbox(onTestFinished);
    const { path, bytes } = await box.tarball(CORE.name, CORE.version);
    await box.onNpm(CORE.name, CORE.version, bytes, { visibleAfter: Infinity });
    await box.release(CORE_TAG);
    const publishedAt = Date.now();
    const published = await record(box, [{ ...CORE, tarball: path, publishedAt }]);

    // The default 6 s window, so that polling continues well after startup.
    const run = await prepare(box, { PUBLISHED_RECORD: published });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "@hussmartinez/sdk-core@1.0.0: this run published it, but it still isn't visible on npm",
    );
    expect(run.stderr).toContain("Re-run the workflow to finish its release.");
    expect(run.output).toBe("count=0\n");
    // It polled with backoff until the window closed.
    const polls = box.polls(CORE.name, CORE.version);
    expect(polls.length).toBeGreaterThan(4);
    // Until the window closed, to within one backoff step: the last poll comes
    // after sleeping until the deadline, and can land just before it.
    expect(polls.at(-1)).toBeGreaterThan(
      publishedAt + 6000 - Number(TIMING.FINISH_POLL_MAX_INTERVAL_MS),
    );
    expect(await prepared(box)).toEqual({});
  });

  it("gives packages published together one shared window, and finishes the others before failing", async ({
    onTestFinished,
  }) => {
    const box = await sandbox(onTestFinished);
    const core = await box.tarball(CORE.name, CORE.version);
    const config = await box.tarball(CONFIG.name, CONFIG.version);
    // Both were published 1 s before this step, with a 6 s window, so the
    // window closes 5 s into the step, not 6 s after each package's own check.
    // sdk-core, checked first, never appears. sdk-config appears 3 s after
    // its publish, inside the window, while the step is still waiting on
    // sdk-core.
    const publishedAt = Date.now() - 1000;
    await box.onNpm(CORE.name, CORE.version, core.bytes, { visibleAfter: Infinity });
    await box.onNpm(CONFIG.name, CONFIG.version, config.bytes, { visibleFrom: publishedAt + 3000 });
    await box.release(CORE_TAG);
    await box.release(CONFIG_TAG);
    const published = await record(box, [
      { ...CORE, tarball: core.path, publishedAt },
      { ...CONFIG, tarball: config.path, publishedAt },
    ]);

    const run = await prepare(box, { PUBLISHED_RECORD: published, FINISH_POLL_TIMEOUT_MS: "6000" });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("@hussmartinez/sdk-core@1.0.0: this run published it");
    expect(run.stderr).not.toContain("sdk-config");
    expect(run.output).toBe("count=1\n");
    expect(await prepared(box)).toEqual({
      "hussmartinez__sdk-config@2.0.0": ["SHA256SUMS", CONFIG_FILE, "release.json"],
    });
    // Waiting from each package's own check instead would poll until at least
    // 1 s past the window, plus the time the script took to start.
    expect(box.polls(CORE.name, CORE.version).at(-1)).toBeLessThan(publishedAt + 6000 + 700);
  });

  it("doesn't wait for a version published longer ago than the window", async ({
    onTestFinished,
  }) => {
    const box = await sandbox(onTestFinished);
    const { path, bytes } = await box.tarball(CORE.name, CORE.version);
    await box.onNpm(CORE.name, CORE.version, bytes, { visibleAfter: Infinity });
    const published = await record(box, [
      { ...CORE, tarball: path, publishedAt: Date.now() - 60_000 },
    ]);

    const run = await prepare(box, { PUBLISHED_RECORD: published });

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/isn't visible on npm 6\d s after its publish/);
    expect(box.polls(CORE.name, CORE.version)).toHaveLength(1);
  });

  it("repairs an earlier run's release that has no files, from npm", async ({ onTestFinished }) => {
    const box = await sandbox(onTestFinished);
    const { bytes } = await box.tarball(CORE.name, CORE.version);
    await box.onNpm(CORE.name, CORE.version, bytes);
    await box.release(CORE_TAG);

    const run = await prepare(box);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      "@hussmartinez/sdk-core@1.0.0: attaching missing files (downloaded from npm).",
    );
    expect(run.output).toBe("count=1\n");
    const npm = (await box.calls()).filter((call) => call.tool === "npm");
    expect(npm.map((call) => call.args.slice(0, 2))).toEqual([["pack", CORE_TAG]]);

    const attached = await attach(box);

    expect(attached.code, attached.stderr).toBe(0);
    const { releases } = await box.github();
    expect(releases[CORE_TAG]?.assets).toEqual([CORE_FILE, "SHA256SUMS"]);
    const gh = (await box.calls()).filter((call) => call.tool === "gh");
    expect(gh.some((call) => call.args[1] === "create")).toBe(false);
  });

  it("creates the missing release for a published, tagged version, with its changelog entry", async ({
    onTestFinished,
  }) => {
    const changelog = [
      "# @hussmartinez/sdk-core",
      "",
      "## 1.0.0",
      "",
      "### Patch Changes",
      "",
      "- Fixed the thing.",
      "",
      "## 0.9.0",
      "",
      "- Older.",
      "",
    ].join("\n");
    const box = await sandbox(onTestFinished, [{ ...CORE, changelog }, CONFIG]);
    const { bytes } = await box.tarball(CORE.name, CORE.version);
    await box.onNpm(CORE.name, CORE.version, bytes);
    await box.tag(CORE_TAG);

    const run = await prepare(box);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("creating the release and attaching files (downloaded from npm)");
    const meta = join(assetsDir(box), "hussmartinez__sdk-core@1.0.0", "release.json");
    expect(JSON.parse(await readFile(meta, "utf8"))).toMatchObject({ needsRelease: true });

    const attached = await attach(box);

    expect(attached.code, attached.stderr).toBe(0);
    const create = (await box.calls()).find((call) => call.args[1] === "create");
    expect(create?.args).toEqual(expect.arrayContaining(["--verify-tag", "--title", CORE_TAG]));
    const { releases } = await box.github();
    expect(releases[CORE_TAG]).toEqual({
      notes: "### Patch Changes\n\n- Fixed the thing.",
      assets: [CORE_FILE, "SHA256SUMS"],
    });
  });

  it("refuses a downloaded tarball that doesn't match the registry", async ({ onTestFinished }) => {
    const box = await sandbox(onTestFinished);
    const { bytes } = await box.tarball(CORE.name, CORE.version);
    const tampered = await box.tarball(CORE.name, CORE.version);
    await box.onNpm(CORE.name, CORE.version, bytes, { served: tampered.path });
    await box.release(CORE_TAG);

    const run = await prepare(box);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(
      /@hussmartinez\/sdk-core@1\.0\.0: the tarball doesn't match the registry \(sha512-.+ instead of sha512-.+\)\./,
    );
    expect(await prepared(box)).toEqual({});
    // No count, so the workflow neither attests nor attaches anything.
    expect(run.output).toBe("");
  });

  it("refuses this run's tarball when it doesn't match the registry", async ({
    onTestFinished,
  }) => {
    const box = await sandbox(onTestFinished);
    const { bytes } = await box.tarball(CORE.name, CORE.version);
    const tampered = await box.tarball(CORE.name, CORE.version);
    await box.onNpm(CORE.name, CORE.version, bytes);
    await box.release(CORE_TAG);
    const published = await record(box, [
      { ...CORE, tarball: tampered.path, publishedAt: Date.now() },
    ]);

    const run = await prepare(box, { PUBLISHED_RECORD: published });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("the tarball doesn't match the registry");
    expect(await prepared(box)).toEqual({});
  });

  it("waits briefly for a version whose planned publish failed, then warns", async ({
    onTestFinished,
  }) => {
    const box = await sandbox(onTestFinished);
    const planned = await plan(box, [CORE]);

    const run = await prepare(box, { PUBLISH_PLAN: planned });

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      "@hussmartinez/sdk-core@1.0.0: not visible on npm yet, but this run planned to publish it; waiting up to 1 s.",
    );
    expect(run.stdout).toContain(
      "::warning title=Not on npm::@hussmartinez/sdk-core@1.0.0: this run planned to publish it, but it isn't on npm.",
    );
    expect(box.polls(CORE.name, CORE.version).length).toBeGreaterThan(1);
    expect(run.output).toBe("count=0\n");
  });

  it("checks once, without waiting, for a version with no sign that it should be on npm", async ({
    onTestFinished,
  }) => {
    const box = await sandbox(onTestFinished);

    const run = await prepare(box);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("@hussmartinez/sdk-core@1.0.0: not on npm, nothing to finish.");
    expect(box.polls(CORE.name, CORE.version)).toHaveLength(1);
    expect(box.polls(CONFIG.name, CONFIG.version)).toHaveLength(1);
    expect(run.output).toBe("count=0\n");
  });

  it("does nothing, and changes nothing on GitHub, when every release is complete", async ({
    onTestFinished,
  }) => {
    const box = await sandbox(onTestFinished);
    for (const [pkg, tag, file] of [
      [CORE, CORE_TAG, CORE_FILE],
      [CONFIG, CONFIG_TAG, CONFIG_FILE],
    ]) {
      const { bytes } = await box.tarball(pkg.name, pkg.version);
      await box.onNpm(pkg.name, pkg.version, bytes);
      await box.release(tag, [file, "SHA256SUMS"]);
    }
    const before = await box.github();

    const run = await prepare(box);
    const attached = await attach(box);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("@hussmartinez/sdk-core@1.0.0: release complete.");
    expect(run.stdout).toContain("@hussmartinez/sdk-config@2.0.0: release complete.");
    // count=0 skips the attestation and attach steps in the workflow.
    expect(run.output).toBe("count=0\n");
    expect(await prepared(box)).toEqual({});
    expect(attached.code).toBe(0);
    expect(attached.stdout).toBe("Nothing to attach.\n");
    // Only reads: one `gh release view` per package, and no npm call.
    const calls = await box.calls();
    expect(calls.map((call) => `${call.tool} ${call.args.slice(0, 2).join(" ")}`)).toEqual([
      "gh release view",
      "gh release view",
    ]);
    expect(await box.github()).toEqual(before);
  });
});

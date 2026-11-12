#!/usr/bin/env node
// Publishes the tarballs that `changeset pack` wrote, for changesets/action's
// publish step (ADR 0021, in sdk-core).
//
// Usage: node publish/publish-packages.mjs <pack-dir> [extra npm arguments]
//
// For each package in <pack-dir>/publish-plan.json, it:
// 1. checks the tarball against the plan's SHA-256 integrity;
// 2. publishes it with npm and provenance. NPM_PUBLISH_COMMAND chooses
//    `publish` (the default) or `stage publish`, which waits for a
//    maintainer's 2FA approval on npm;
// 3. records it in $PUBLISHED_RECORD, if set, as soon as npm accepts it, with
//    the time, so the release can be finished even if another package fails
//    and the wait for npm counts from the publish (finish-releases.mjs);
// 4. creates the annotated tag `<name>@<version>`, and reports it in
//    $CHANGESETS_OUTPUT, so changesets/action pushes the tag and creates the
//    GitHub Release.
//
// npm, not pnpm, publishes the tarballs: it's the client that supports trusted
// publishing and staging. `changeset pack` has already rewritten `catalog:` and
// `workspace:` ranges.
//
// test/release/ runs it end to end with a fake npm on PATH.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const print = (text) => process.stdout.write(`${text}\n`);
const fail = (text) => process.stderr.write(`${text}\n`);

const [packDir, ...npmArguments] = process.argv.slice(2);
if (!packDir) {
  fail("Usage: node publish/publish-packages.mjs <pack-dir> [extra npm arguments]");
  process.exit(2);
}

const command = (process.env.NPM_PUBLISH_COMMAND ?? "publish").split(" ");
if (!["publish", "stage publish"].includes(command.join(" "))) {
  fail(`NPM_PUBLISH_COMMAND must be "publish" or "stage publish".`);
  process.exit(2);
}
const dryRun = npmArguments.includes("--dry-run");

/** @type {{ plan: Array<Array<{ kind: string, name: string, version: string, access: string, tag: string, tarball?: { path: string, integrity: string } }>> }} */
const { plan } = JSON.parse(readFileSync(join(packDir, "publish-plan.json"), "utf8"));
const steps = plan.flat().filter((step) => step.kind === "publish");
let failed = false;

for (const step of steps) {
  const label = `${step.name}@${step.version}`;
  try {
    if (!step.tarball) {
      throw new Error("the plan has no tarball; run changeset pack first");
    }
    const tarball = join(packDir, step.tarball.path);
    const integrity = `sha256-${createHash("sha256").update(readFileSync(tarball)).digest("base64")}`;
    if (integrity !== step.tarball.integrity) {
      throw new Error(`${tarball} doesn't match the plan's integrity`);
    }

    execFileSync(
      "npm",
      [
        ...command,
        tarball,
        "--provenance",
        "--access",
        step.access,
        "--tag",
        step.tag,
        ...npmArguments,
      ],
      { stdio: "inherit" },
    );

    if (!dryRun) {
      if (process.env.PUBLISHED_RECORD) {
        appendFileSync(
          process.env.PUBLISHED_RECORD,
          `${JSON.stringify({ name: step.name, version: step.version, tarball, publishedAt: Date.now() })}\n`,
        );
      }
      try {
        execFileSync("git", ["tag", "--annotate", label, "--message", label], { stdio: "inherit" });
      } catch (error) {
        throw new Error(
          `it was published, but tagging it failed: ${error instanceof Error ? error.message : error}`,
        );
      }
      if (process.env.CHANGESETS_OUTPUT) {
        appendFileSync(
          process.env.CHANGESETS_OUTPUT,
          `${JSON.stringify({ type: "git-tag", tag: label, packageName: step.name })}\n`,
        );
      }
    }
    print(`${dryRun ? "Would publish" : "Published"} ${label}`);
  } catch (error) {
    // Keep going, so that packages that did publish still get tags and releases.
    failed = true;
    fail(`Failed to publish ${label}: ${error instanceof Error ? error.message : error}`);
  }
}

if (steps.length === 0) {
  print("Nothing to publish.");
}
process.exit(failed ? 1 : 0);

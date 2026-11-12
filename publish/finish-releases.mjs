#!/usr/bin/env node
// Finishes the GitHub Release of every package version that's on npm: the
// tarball and SHA256SUMS attached, with an attestation (ADR 0021, in
// sdk-core). It's safe to run again: it compares the current state on npm
// and GitHub, so a rerun or a later push repairs a release that an earlier,
// partly failed run left unfinished, and a complete release is left alone.
//
// Usage:
//   node publish/finish-releases.mjs prepare <dir>
//   node publish/finish-releases.mjs attach <dir>
//
// `prepare` looks at each public workspace package at its current version.
// Versions that aren't on npm, and releases that already have both files, are
// skipped. For the rest, it takes the tarball this run published (listed in
// $PUBLISHED_RECORD) or downloads it from the registry, verifies it against the
// registry's dist.integrity, and writes it with SHA256SUMS to <dir>. It sets
// `count` in $GITHUB_OUTPUT, so the workflow attests only those files. A
// version this run published that never becomes visible on npm fails the step,
// but only after the other packages are prepared.
//
// `attach` creates any missing release, from its existing tag and the
// changelog, and uploads the files in <dir>.
//
// It uses `npm` and `gh`, with GH_TOKEN and GITHUB_REPOSITORY from the
// workflow. test/release/ runs it end to end against a fake registry, npm and
// gh, through NPM_REGISTRY_URL, PATH and the FINISH_POLL_* variables.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const print = (text) => process.stdout.write(`${text}\n`);
const fail = (text) => process.stderr.write(`${text}\n`);

const [command, dir] = process.argv.slice(2);
if (!["prepare", "attach"].includes(command ?? "") || !dir) {
  fail("Usage: node publish/finish-releases.mjs <prepare|attach> <dir>");
  process.exit(2);
}
const repository = process.env.GITHUB_REPOSITORY;
if (!repository) {
  fail("GITHUB_REPOSITORY must be set, such as ie-huss-martinez/sdk-core.");
  process.exit(2);
}

const run = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const SUMS = "SHA256SUMS";

/** The npm tarball name, such as hussmartinez-sdk-core-0.1.1.tgz. */
const tarballName = (name, version) => `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

const registry = (
  process.env.NPM_REGISTRY_URL ?? run("npm", ["config", "get", "registry"])
).replace(/\/?$/, "/");
// How long to wait for a version that should be on npm, all overridable for
// tests. npm can take minutes to process a new version before it's served:
// about 1 minute for 0.1.0 and 0.1.1, but 3 to 4 minutes for sdk-config 0.1.2.
// So a version this run published gets up to 10 minutes from its publish, and
// one that only has another sign of being on npm (a plan, release or tag) gets
// 1 minute. Polls back off from 5 s, doubling up to 30 s, with jitter.
const pollInterval = Number(process.env.FINISH_POLL_INTERVAL_MS ?? 5_000);
const pollMaxInterval = Number(process.env.FINISH_POLL_MAX_INTERVAL_MS ?? 30_000);
const publishedTimeout = Number(process.env.FINISH_POLL_TIMEOUT_MS ?? 600_000);
const signTimeout = Number(process.env.FINISH_POLL_SIGN_TIMEOUT_MS ?? 60_000);

const seconds = (ms) => `${Math.round(ms / 1000)} s`;

/**
 * The registry's integrity for a version, or undefined when it isn't on npm.
 *
 * It reads the version's own document (`<registry>/<name>/<version>`), not the
 * package document that `npm view` reads: the registry's CDN caches the
 * package document for up to five minutes, so a version published moments
 * ago can be missing from it, while the version document isn't cached.
 */
async function registryIntegrity(name, version) {
  const url = `${registry}${name.replace("/", "%2f")}/${version}`;
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`${name}@${version}: the registry answered ${response.status} for ${url}.`);
  }
  const manifest = await response.json();
  return typeof manifest?.dist?.integrity === "string" ? manifest.dist.integrity : undefined;
}

/**
 * After a check that didn't find the version, polls registryIntegrity until the
 * deadline, for a version that should be on npm but may not be visible yet.
 * The delay between polls doubles from pollInterval up to pollMaxInterval, and
 * each delay is randomised between half and all of it, so that retries don't
 * fall into step.
 */
async function waitForIntegrity(name, version, deadline) {
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return undefined;
    }
    const backoff = Math.min(pollMaxInterval, pollInterval * 2 ** attempt);
    const delay = Math.min(remaining, backoff / 2 + Math.random() * (backoff / 2));
    print(`${name}@${version}: not visible on npm yet, checking again in ${seconds(delay)}.`);
    sleep(delay);
    const integrity = await registryIntegrity(name, version);
    if (integrity) {
      return integrity;
    }
  }
}

/** Whether the tag exists on GitHub. */
function tagExists(tag) {
  const refs = JSON.parse(run("gh", ["api", `repos/${repository}/git/matching-refs/tags/${tag}`]));
  return refs.some((ref) => ref.ref === `refs/tags/${tag}`);
}

/** The versions in this run's publish plan, as name@version. */
function plannedThisRun() {
  const plan = process.env.PUBLISH_PLAN;
  if (!plan || !existsSync(plan)) {
    return new Set();
  }
  const steps = JSON.parse(readFileSync(plan, "utf8")).plan.flat();
  return new Set(
    steps.filter((step) => step.kind === "publish").map((step) => `${step.name}@${step.version}`),
  );
}

/** The release's asset names, or undefined when there's no release. */
function releaseAssets(tag) {
  try {
    const json = run("gh", ["release", "view", tag, "--repo", repository, "--json", "assets"]);
    return JSON.parse(json).assets.map((asset) => asset.name);
  } catch (error) {
    if (/release not found/i.test(String(error?.stderr ?? error))) {
      return undefined;
    }
    throw error;
  }
}

function integrityOf(file, algorithm) {
  return `${algorithm}-${createHash(algorithm).update(readFileSync(file)).digest("base64")}`;
}

function workspacePackages() {
  const packages = JSON.parse(run("pnpm", ["ls", "--recursive", "--depth", "-1", "--json"]));
  return packages.filter((pkg) => !pkg.private && pkg.name && pkg.version);
}

function publishedThisRun() {
  const record = process.env.PUBLISHED_RECORD;
  if (!record || !existsSync(record)) {
    return new Map();
  }
  const entries = readFileSync(record, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return new Map(entries.map((entry) => [`${entry.name}@${entry.version}`, entry]));
}

async function prepare() {
  const published = publishedThisRun();
  const planned = plannedThisRun();
  const failures = [];
  let count = 0;

  for (const pkg of workspacePackages()) {
    const tag = `${pkg.name}@${pkg.version}`;
    const thisRun = published.get(tag);
    const assets = releaseAssets(tag);
    let integrity = await registryIntegrity(pkg.name, pkg.version);
    // When this run published the version, the wait counts from the publish,
    // so several packages published together share one window.
    const since = Number(thisRun?.publishedAt) || Date.now();

    if (!integrity) {
      // Wait when there's a sign that the version should be on npm.
      const reason = thisRun
        ? "this run published it"
        : planned.has(tag)
          ? "this run planned to publish it"
          : assets
            ? "it has a GitHub Release"
            : tagExists(tag)
              ? "it has a tag"
              : undefined;
      if (reason) {
        const timeout = thisRun ? publishedTimeout : signTimeout;
        print(
          `${tag}: not visible on npm yet, but ${reason}; waiting up to ${seconds(timeout)}${thisRun ? " from its publish" : ""}.`,
        );
        integrity = await waitForIntegrity(pkg.name, pkg.version, since + timeout);
      }
      if (!integrity && thisRun) {
        // Fail the step, but only after finishing the other packages.
        failures.push(
          `${tag}: this run published it, but it still isn't visible on npm ${seconds(Date.now() - since)} after its publish. Re-run the workflow to finish its release.`,
        );
        continue;
      }
      if (!integrity && reason) {
        process.stdout.write(
          `::warning title=Not on npm::${tag}: ${reason}, but it isn't on npm.\n`,
        );
      }
      if (!integrity) {
        print(`${tag}: not on npm, nothing to finish.`);
        continue;
      }
    }
    if (thisRun) {
      // Recorded on every release, to learn how long npm really takes.
      process.stdout.write(
        `::notice title=Visible on npm::${tag}: visible on npm ${seconds(Date.now() - since)} after its publish.\n`,
      );
    }

    const file = tarballName(pkg.name, pkg.version);
    if (assets?.includes(file) && assets.includes(SUMS)) {
      print(`${tag}: release complete.`);
      continue;
    }

    // Prefer the tarball this run published; otherwise download it.
    let source = thisRun?.tarball;
    if (!source || !existsSync(source)) {
      const downloads = mkdtempSync(join(tmpdir(), "finish-release-"));
      run("npm", ["pack", tag, "--pack-destination", downloads]);
      source = join(downloads, file);
    }
    const [algorithm] = integrity.split("-");
    const actual = integrityOf(source, algorithm);
    if (actual !== integrity) {
      throw new Error(
        `${tag}: the tarball doesn't match the registry (${actual} instead of ${integrity}).`,
      );
    }

    const target = join(dir, tag.replace(/^@/, "").replace("/", "__"));
    mkdirSync(target, { recursive: true });
    copyFileSync(source, join(target, file));
    const sha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
    writeFileSync(join(target, SUMS), `${sha256}  ./${file}\n`);
    writeFileSync(
      join(target, "release.json"),
      JSON.stringify({ tag, path: pkg.path, version: pkg.version, file, needsRelease: !assets }),
    );
    print(
      `${tag}: ${assets ? "attaching missing files" : "creating the release and attaching files"} (${thisRun ? "this run's tarball" : "downloaded from npm"}).`,
    );
    count += 1;
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `count=${count}\n`);
  }
  print(`Releases to finish: ${count}`);
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

/** The changelog section for a version, as release notes. */
function releaseNotes(path, version) {
  const changelog = join(path, "CHANGELOG.md");
  if (!existsSync(changelog)) {
    return "";
  }
  const lines = readFileSync(changelog, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) {
    return "";
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

function attach() {
  if (!existsSync(dir)) {
    print("Nothing to attach.");
    return;
  }
  let failed = false;
  for (const entry of readdirSync(dir)) {
    const target = join(dir, entry);
    const meta = JSON.parse(readFileSync(join(target, "release.json"), "utf8"));
    try {
      if (meta.needsRelease) {
        // Only from an existing tag: a release must point at the commit that
        // was actually published, which only its tag records.
        const notes = join(target, "NOTES.md");
        writeFileSync(notes, releaseNotes(meta.path, meta.version));
        run("gh", [
          "release",
          "create",
          meta.tag,
          "--repo",
          repository,
          "--verify-tag",
          "--title",
          meta.tag,
          "--notes-file",
          notes,
        ]);
        print(`${meta.tag}: release created.`);
      }
      run("gh", [
        "release",
        "upload",
        meta.tag,
        join(target, meta.file),
        join(target, SUMS),
        "--repo",
        repository,
        "--clobber",
      ]);
      print(`${meta.tag}: attached ${meta.file} and ${SUMS}.`);
    } catch (error) {
      failed = true;
      fail(`${meta.tag}: ${String(error?.stderr || error?.message || error).trim()}`);
    }
  }
  if (failed) {
    process.exit(1);
  }
}

try {
  if (command === "prepare") {
    await prepare();
  } else {
    attach();
  }
} catch (error) {
  fail(String(error?.message ?? error));
  process.exit(1);
}

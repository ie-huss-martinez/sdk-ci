#!/usr/bin/env node
// Releases sdk-ci when a release pull request is merged: if package.json's
// version has no tag yet, it tags the merged commit vX.Y.Z and creates its
// GitHub Release, with that version's section of CHANGELOG.md as the notes.
// On every other push it does nothing.
//
// Usage: node scripts/release.mjs [--check]
//
// Version 0.0.0 means nothing has been released yet, so it needs no
// changelog section and nothing is tagged.
//
// With --check, it only checks that the version is valid and has a changelog
// section, without calling GitHub; pnpm verify runs that on every pull
// request. Otherwise it needs GITHUB_REPOSITORY, GITHUB_SHA and GH_TOKEN, as
// the release workflow provides, and the `gh` CLI.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const print = (text) => process.stdout.write(`${text}\n`);
const fail = (text) => {
  process.stderr.write(`${text}\n`);
  process.exit(1);
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
if (!SEMVER.test(String(version))) {
  fail(`package.json's version, "${version}", must be MAJOR.MINOR.PATCH.`);
}
const tag = `v${version}`;

// 0.0.0 means nothing has been released yet.
if (version === "0.0.0") {
  print("Version 0.0.0: nothing to release yet.");
  process.exit(0);
}

/** The changelog section for this version, without its heading. */
function notes() {
  const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${tag}`);
  if (start === -1) {
    fail(`CHANGELOG.md has no "## ${tag}" section for package.json's version.`);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
  if (!body) {
    fail(`CHANGELOG.md's "## ${tag}" section is empty.`);
  }
  return body;
}

const body = notes();
if (process.argv.includes("--check")) {
  print(`${tag}: valid, with release notes in CHANGELOG.md.`);
  process.exit(0);
}

const repository = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
if (!repository || !sha) {
  fail("GITHUB_REPOSITORY and GITHUB_SHA must be set, as in the release workflow.");
}

const gh = (...args) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Compares two MAJOR.MINOR.PATCH versions. */
function compare(a, b) {
  const [x, y] = [a, b].map((value) => value.split(".").map(Number));
  for (let index = 0; index < 3; index += 1) {
    const difference = (x?.[index] ?? 0) - (y?.[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

const existing = JSON.parse(gh("api", `repos/${repository}/git/matching-refs/tags/v`))
  .map((ref) => String(ref.ref).replace("refs/tags/v", ""))
  .filter((value) => SEMVER.test(value));

if (existing.includes(version)) {
  print(`${tag} is already released; nothing to do.`);
  process.exit(0);
}
const latest = existing.sort(compare).at(-1);
if (latest && compare(version, latest) < 0) {
  fail(`${tag} is lower than the latest release, v${latest}. Raise package.json's version.`);
}

const file = join(tmpdir(), `sdk-ci-${tag}-notes.md`);
writeFileSync(file, `${body}\n`);
gh(
  "release",
  "create",
  tag,
  "--repo",
  repository,
  "--target",
  sha,
  "--title",
  tag,
  "--notes-file",
  file,
);
print(`Released ${tag} at ${sha}.`);

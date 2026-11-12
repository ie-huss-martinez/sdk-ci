#!/usr/bin/env node
// Leaves dev-only package.json changes out of the changeset check (ADR 0027,
// in sdk-core).
//
// Usage: node dev-only.mjs [base-ref]   (default: origin/main)
//
// For each workspace package whose package.json differs from the merge base
// of base-ref and HEAD, it compares the two versions without the dev-only
// fields: devDependencies, scripts, packageManager and devEngines. If nothing
// else differs, it restores the merge-base version in the working tree and
// logs that it did. `changeset status --since=<base-ref>` compares the merge
// base with the working tree, so it then doesn't count that file.
//
// Everything else counts: any other field, and a package.json that's new,
// deleted or can't be parsed at either commit. Packages that are private at
// both commits are left alone, as Changesets ignores them.
//
// It changes only the working tree of the job that runs it, never a commit.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The fields that never reach users, as listed in ADR 0027. */
const DEV_ONLY = ["devDependencies", "scripts", "packageManager", "devEngines"];

const print = (text) => process.stdout.write(`${text}\n`);
const run = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** JSON with sorted keys, so that key order doesn't count as a change. */
function canonical(value) {
  return JSON.stringify(value, (_, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

const parse = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** The fields whose values differ between two manifests. */
const differing = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => canonical(a[key]) !== canonical(b[key]))
    .sort();

const ref = process.argv[2] ?? "origin/main";
const base = run("git", ["merge-base", ref, "HEAD"]);
const root = run("git", ["rev-parse", "--show-toplevel"]);
let packages;
try {
  packages = JSON.parse(run("pnpm", ["ls", "--recursive", "--depth", "-1", "--json"]));
} catch (error) {
  // pnpm can't list the workspace, for example because a package.json is
  // invalid. Nothing is left out, so the check fails on its own terms.
  const reason = String(error?.stderr || error?.message || error).trim();
  process.stdout.write(
    `::error::Can't list the workspace's packages, so nothing is left out: ${reason}\n`,
  );
  process.exit(1);
}

let hidden = 0;
for (const pkg of packages) {
  const file = relative(root, join(pkg.path, "package.json")).split(sep).join("/");
  let current;
  let previous;
  try {
    current = readFileSync(join(root, file), "utf8");
    // Exactly as committed, so that restoring it leaves no difference.
    previous = execFileSync("git", ["show", `${base}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    continue; // New or deleted: it counts.
  }
  if (current === previous) {
    continue;
  }
  const now = parse(current);
  const before = parse(previous);
  if (!now || !before) {
    print(`${file}: can't be read at both commits, so it counts.`);
    continue;
  }
  if (now.private === true && before.private === true) {
    continue; // Changesets ignores private packages.
  }
  const changed = differing(before, now);
  const reaching = changed.filter((key) => !DEV_ONLY.includes(key));
  if (reaching.length > 0) {
    print(`${file}: ${reaching.join(", ")} changed, which reach users, so it counts.`);
    continue;
  }
  writeFileSync(join(root, file), previous);
  hidden += 1;
  print(
    `${file}: only ${changed.length > 0 ? changed.join(", ") : "formatting"} changed, so it isn't counted (ADR 0027).`,
  );
}
print(
  hidden === 0
    ? "No dev-only package.json changes to leave out."
    : `Left out ${hidden} dev-only package.json change${hidden === 1 ? "" : "s"}.`,
);

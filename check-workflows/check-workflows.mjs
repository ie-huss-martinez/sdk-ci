#!/usr/bin/env node
// Checks a repository's workflows against sdk-ci's canonical skeleton
// (ADR 0026, in sdk-core).
//
// Usage: node check-workflows.mjs <skeleton-dir> <workflows-dir>
//
// For each workflow in <skeleton-dir>, the repository's file of the same name
// must exist and match it:
// - the workflow's `name`, `on`, `permissions` and `concurrency`;
// - every skeleton job, by id: its name, needs, if, runner, timeout,
//   environment, permissions, container, outputs and steps. A job may add
//   environment variables of its own, but must keep the skeleton's.
// Steps that use sdk-ci's actions are compared without their ref. Instead,
// every sdk-ci reference in the repository's workflows must use one and the
// same full commit SHA, with the same version comment.
//
// Jobs and workflows that the skeleton doesn't have are allowed: they're the
// repository's own.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const SDK_CI = "ie-huss-martinez/sdk-ci/";
const COMPARED_JOB_KEYS = [
  "name",
  "needs",
  "if",
  "runs-on",
  "timeout-minutes",
  "environment",
  "permissions",
  "container",
  "outputs",
  "uses",
  "with",
  "secrets",
  "strategy",
  "steps",
];

const [skeletonDir, workflowsDir] = process.argv.slice(2);
if (!skeletonDir || !workflowsDir) {
  process.stderr.write("Usage: node check-workflows.mjs <skeleton-dir> <workflows-dir>\n");
  process.exit(2);
}

/** @type {Array<{ file: string, message: string }>} */
const problems = [];
const problem = (file, message) => problems.push({ file, message });

/** JSON with sorted keys, so that key order doesn't matter. */
function canonical(value) {
  return JSON.stringify(value, (_, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

const same = (a, b) => canonical(a) === canonical(b);

/** A step's or job's `uses`, without the ref when it's one of sdk-ci's actions. */
const withoutRef = (uses) =>
  typeof uses === "string" && uses.startsWith(SDK_CI) ? uses.replace(/@.*$/, "") : uses;

/** A job with its steps' sdk-ci refs removed and `needs` as a list. */
function normalised(job) {
  const copy = structuredClone(job ?? {});
  if (typeof copy.needs === "string") {
    copy.needs = [copy.needs];
  }
  if (copy.uses) {
    copy.uses = withoutRef(copy.uses);
  }
  copy.steps = copy.steps?.map((step) => ({ ...step, uses: withoutRef(step.uses) }));
  return copy;
}

const show = (value) => (value === undefined ? "nothing" : canonical(value));

const skeletonFiles = readdirSync(skeletonDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();

for (const name of skeletonFiles) {
  const file = join(workflowsDir, name);
  const skeleton = parse(readFileSync(join(skeletonDir, name), "utf8"));
  let workflow;
  try {
    workflow = parse(readFileSync(file, "utf8"));
  } catch (error) {
    problem(
      file,
      error?.code === "ENOENT" ? "is missing" : `can't be read: ${error?.message ?? error}`,
    );
    continue;
  }

  for (const key of ["name", "on", "permissions", "concurrency"]) {
    if (!same(workflow?.[key], skeleton[key])) {
      problem(file, `\`${key}\` is ${show(workflow?.[key])}, expected ${show(skeleton[key])}`);
    }
  }

  for (const [id, expectedJob] of Object.entries(skeleton.jobs ?? {})) {
    const actualJob = workflow?.jobs?.[id];
    if (!actualJob) {
      problem(file, `job \`${id}\` is missing`);
      continue;
    }
    const expected = normalised(expectedJob);
    const actual = normalised(actualJob);
    for (const key of COMPARED_JOB_KEYS) {
      if (!same(actual[key], expected[key])) {
        problem(
          file,
          `job \`${id}\`: \`${key}\` is ${show(actual[key])}, expected ${show(expected[key])}`,
        );
      }
    }
    for (const [variable, value] of Object.entries(expected.env ?? {})) {
      if (!same(actual.env?.[variable], value)) {
        problem(
          file,
          `job \`${id}\`: env \`${variable}\` is ${show(actual.env?.[variable])}, expected ${show(value)}`,
        );
      }
    }
  }
}

// Every sdk-ci reference, in every workflow of the repository, must be the
// same full SHA with the same version comment.
/** @type {Map<string, string[]>} */
const refs = new Map();
for (const name of readdirSync(workflowsDir).filter((entry) => /\.ya?ml$/.test(entry))) {
  const file = join(workflowsDir, name);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    const match = /uses:\s*ie-huss-martinez\/sdk-ci\/[\w./-]+@(\S+)(?:\s+#\s*(.*\S))?/.exec(line);
    if (!match) {
      return;
    }
    const [, ref = "", version = ""] = match;
    const where = `${file}:${index + 1}`;
    if (!/^[0-9a-f]{40}$/.test(ref)) {
      problem(file, `line ${index + 1}: sdk-ci must be pinned to a full commit SHA, not "${ref}"`);
    }
    if (!/^v\d+\.\d+\.\d+$/.test(version)) {
      problem(file, `line ${index + 1}: the sdk-ci pin needs its version in a "# vX.Y.Z" comment`);
    }
    const key = `${ref} # ${version}`;
    refs.set(key, [...(refs.get(key) ?? []), where]);
  });
}
if (refs.size > 1) {
  const listed = [...refs].map(([ref, where]) => `${ref} (${where.join(", ")})`).join("; ");
  problem(workflowsDir, `sdk-ci is pinned to more than one version: ${listed}`);
}

if (problems.length > 0) {
  for (const { file, message } of problems) {
    process.stdout.write(`::error file=${file}::${file}: ${message}\n`);
  }
  process.stdout.write(
    `${problems.length} difference${problems.length === 1 ? "" : "s"} from sdk-ci's skeleton. Update the workflows to match the skeleton of the sdk-ci version they pin.\n`,
  );
  process.exit(1);
}
const [pinned = "no version"] = [...refs.keys()];
process.stdout.write(
  `The workflows match sdk-ci's skeleton (${skeletonFiles.length} files, sdk-ci ${pinned}).\n`,
);

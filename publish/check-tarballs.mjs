#!/usr/bin/env node
// Checks the tarballs that `changeset pack` wrote before anything publishes
// them (ADR 0041, in sdk-core). The verify action runs it after packing, and
// the publish action runs it again on the files it downloaded.
//
// Usage: node publish/check-tarballs.mjs <pack-dir> [--publint <command>]
//
// For each package in <pack-dir>/publish-plan.json, it extracts the tarball
// and fails, naming the missing paths, unless the tarball contains every file
// that its package.json's `main`, `module`, `types`, `typings`, `bin` and
// `exports` point to. An `exports` pattern with `*` must match at least one
// file. With --publint, it also runs `<command> run <tarball> --strict` on
// each tarball, as the verify job does; the publish job doesn't, because
// publint is third-party code and the job holds the OIDC token.
//
// It uses only Node and the system's `tar`, so the publish job can run it
// without installing anything.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const print = (text) => process.stdout.write(`${text}\n`);
const fail = (text) => process.stderr.write(`${text}\n`);

const USAGE = "Usage: node publish/check-tarballs.mjs <pack-dir> [--publint <command>]";

/**
 * The paths a package.json points to, relative to the package root and
 * without a leading `./`, with the field that names each.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {Array<{ path: string, field: string }>}
 */
export function referencedPaths(manifest) {
  /** @type {Array<{ path: string, field: string }>} */
  const paths = [];
  const add = (/** @type {unknown} */ value, /** @type {string} */ field) => {
    if (typeof value === "string" && value !== "") {
      paths.push({ path: value.replace(/^\.\//, ""), field });
    }
  };
  for (const field of ["main", "module", "types", "typings"]) {
    add(manifest[field], field);
  }
  const { bin, exports } = manifest;
  if (typeof bin === "string") {
    add(bin, "bin");
  } else if (bin && typeof bin === "object") {
    for (const [name, path] of Object.entries(bin)) {
      add(path, `bin.${name}`);
    }
  }
  /** Every string target in `exports`, at any depth of conditions and subpaths. */
  const walk = (/** @type {unknown} */ value, /** @type {string} */ field) => {
    if (typeof value === "string") {
      add(value, field);
    } else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        walk(item, `${field}[${index}]`);
      }
    } else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        walk(inner, `${field}["${key}"]`);
      }
    }
  };
  walk(exports, "exports");
  return paths;
}

/**
 * The referenced paths that none of the files match. A `*` in an `exports`
 * target matches any characters, including `/`, as Node resolves it.
 *
 * @param {Array<{ path: string, field: string }>} paths
 * @param {Set<string>} files - The package's files, relative to its root.
 */
export function missingPaths(paths, files) {
  return paths.filter(({ path }) => {
    if (!path.includes("*")) {
      return !files.has(path);
    }
    const pattern = new RegExp(
      `^${path
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    return ![...files].some((file) => pattern.test(file));
  });
}

/** Every file under a directory, relative to it, with `/` separators. */
function listFiles(/** @type {string} */ root) {
  /** @type {string[]} */
  const files = [];
  const visit = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        files.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  visit(root);
  return files;
}

/**
 * Checks one tarball, and returns its problems.
 *
 * @param {string} tarball
 * @param {string | undefined} publint
 * @returns {string[]}
 */
export function checkTarball(tarball, publint) {
  const work = mkdtempSync(join(tmpdir(), "check-tarball-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", work]);
    const root = join(work, "package");
    const files = new Set(listFiles(root));
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const problems = missingPaths(referencedPaths(manifest), files).map(
      ({ path, field }) => `${path} (${field}) isn't in the tarball`,
    );
    if (publint) {
      const [command, ...args] = publint.split(" ");
      const result = spawnSync(command ?? "publint", [...args, "run", tarball, "--strict"], {
        encoding: "utf8",
      });
      if (result.status !== 0) {
        problems.push(
          `publint --strict failed:\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`,
        );
      }
    }
    return problems;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const publintAt = args.indexOf("--publint");
  const publint = publintAt === -1 ? undefined : args[publintAt + 1];
  const [packDir] = publintAt === 0 ? args.slice(2) : args;
  if (!packDir || (publintAt !== -1 && !publint)) {
    fail(USAGE);
    process.exit(2);
  }

  /** @type {{ plan: Array<Array<{ kind: string, name: string, version: string, tarball?: { path: string } }>> }} */
  const { plan } = JSON.parse(readFileSync(join(packDir, "publish-plan.json"), "utf8"));
  const steps = plan.flat().filter((step) => step.kind === "publish");
  let failed = false;
  for (const step of steps) {
    const label = `${step.name}@${step.version}`;
    if (!step.tarball) {
      fail(`::error title=Not packed::${label}: the plan has no tarball.`);
      failed = true;
      continue;
    }
    const problems = checkTarball(join(packDir, step.tarball.path), publint);
    if (problems.length > 0) {
      fail(
        `::error title=Incomplete tarball::${label}: ${problems.length} problem${problems.length === 1 ? "" : "s"}, so nothing is published.`,
      );
      for (const problem of problems) {
        fail(`  ${label}: ${problem}`);
      }
      failed = true;
    } else {
      print(
        `${label}: every referenced file is in the tarball${publint ? ", and publint passes" : ""}.`,
      );
    }
  }
  if (steps.length === 0) {
    print("No tarballs to check.");
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

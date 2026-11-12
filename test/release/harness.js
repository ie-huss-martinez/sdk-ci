// A sandbox for testing publish/publish-packages.mjs and
// publish/finish-releases.mjs end to end, through their real command lines.
//
// - npm's registry is a local HTTP server, through NPM_REGISTRY_URL. It
//   serves each version document once it has been polled a given number of
//   times, and records every poll.
// - `npm` and `gh` are fakes, first on PATH, that keep their state in a JSON
//   file and log every call (fake-npm.js, fake-gh.js).
// - `pnpm ls` and `git` are real, in a fixture workspace that's a git
//   repository, with no user or system git config.
// - Time is scaled down through the scripts' FINISH_POLL_* variables, and a
//   version's publish time comes from the record that publish-packages writes.

import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FAKES = fileURLToPath(new URL(".", import.meta.url));

export const SCRIPTS = {
  publish: join(ROOT, "publish", "publish-packages.mjs"),
  finish: join(ROOT, "publish", "finish-releases.mjs"),
};

/**
 * The polling the tests use, 100 times faster than in a release: 50 ms
 * doubling to 300 ms, a 6 s window from a publish, and 600 ms for a version
 * with only another sign of being on npm.
 */
export const TIMING = {
  FINISH_POLL_INTERVAL_MS: "50",
  FINISH_POLL_MAX_INTERVAL_MS: "300",
  FINISH_POLL_TIMEOUT_MS: "6000",
  FINISH_POLL_SIGN_TIMEOUT_MS: "600",
};

/**
 * @typedef {{ name: string, version: string, dir: string, changelog?: string }} Package
 * @typedef {{ tool: string, args: string[] }} Call
 * @typedef {{ code: number, stdout: string, stderr: string, output: string, ms: number }} Run
 */

/** The npm tarball name, such as hussmartinez-sdk-core-1.0.0.tgz. */
export const tarballName = (/** @type {string} */ name, /** @type {string} */ version) =>
  `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

/** @param {Buffer} bytes @param {"sha256" | "sha512"} algorithm */
export const integrityOf = (bytes, algorithm) =>
  `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;

/**
 * Creates a sandbox with a fixture workspace of the given packages.
 *
 * @param {Package[]} packages
 */
export async function createSandbox(packages) {
  const root = await mkdtemp(join(tmpdir(), "hm-release-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const temp = join(root, "runner-temp");
  await Promise.all([state, bin, temp].map((dir) => mkdir(dir, { recursive: true })));

  // The fakes, as `npm` and `gh` executables.
  for (const tool of ["npm", "gh"]) {
    const file = join(bin, tool);
    await writeFile(file, `#!/bin/sh\nexec node "${join(FAKES, `fake-${tool}.js`)}" "$@"\n`);
    await chmod(file, 0o755);
  }

  /** @type {{ tags: string[], releases: Record<string, { assets: string[], notes?: string }>, packs: Record<string, string>, publishFails: string[] }} */
  const fake = { tags: [], releases: {}, packs: {}, publishFails: [] };
  const stateFile = join(state, "state.json");
  const saveState = () => writeFile(stateFile, JSON.stringify(fake));
  await saveState();
  await writeFile(join(state, "calls.ndjson"), "");

  // The fixture workspace, for `pnpm ls` and `git tag`.
  const files = {
    "package.json": '{ "name": "workspace", "private": true }\n',
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  };
  for (const pkg of packages) {
    files[`packages/${pkg.dir}/package.json`] = JSON.stringify({
      name: pkg.name,
      version: pkg.version,
    });
    if (pkg.changelog) {
      files[`packages/${pkg.dir}/CHANGELOG.md`] = pkg.changelog;
    }
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fixture"],
  ]) {
    execFileSync("git", args, { cwd: workspace, env: gitEnv, stdio: "ignore" });
  }

  // The registry: version documents only, as finish-releases reads them.
  /** @type {Map<string, { integrity: string, visibleAfter: number, visibleFrom: number }>} */
  const versions = new Map();
  /** @type {Map<string, number[]>} */
  const polls = new Map();
  const server = createServer((request, response) => {
    const match = /^\/(.+)\/([^/]+)$/.exec(request.url ?? "");
    const key = match ? `${decodeURIComponent(match[1] ?? "")}@${match[2]}` : (request.url ?? "");
    const times = polls.get(key) ?? [];
    times.push(Date.now());
    polls.set(key, times);
    const entry = versions.get(key);
    if (!entry || times.length <= entry.visibleAfter || Date.now() < entry.visibleFrom) {
      response.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ dist: { integrity: entry.integrity } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const sandbox = {
    root,
    workspace,
    /** $RUNNER_TEMP in the workflow. */
    temp,
    gitEnv,

    /**
     * Writes a tarball with random contents and returns its path and bytes.
     *
     * @param {string} name
     * @param {string} version
     * @param {string} [dir] - Where to write it; a fresh directory by default.
     */
    async tarball(name, version, dir) {
      const target = dir ?? (await mkdtemp(join(root, "tarball-")));
      await mkdir(target, { recursive: true });
      const path = join(target, tarballName(name, version));
      const bytes = randomBytes(256);
      await writeFile(path, bytes);
      return { path, bytes };
    },

    /**
     * Puts a version on the fake npm: its document, visible after
     * `visibleAfter` polls (Infinity for never) and from the time
     * `visibleFrom`, as npm serves a version once it has processed it. Also
     * the tarball `npm pack`
     * downloads, which is `bytes` unless `served` is given.
     *
     * @param {string} name
     * @param {string} version
     * @param {Buffer} bytes
     * @param {{ visibleAfter?: number, visibleFrom?: number, served?: string }} [options]
     */
    async onNpm(name, version, bytes, { visibleAfter = 0, visibleFrom = 0, served } = {}) {
      versions.set(`${name}@${version}`, {
        integrity: integrityOf(bytes, "sha512"),
        visibleAfter,
        visibleFrom,
      });
      const pack = served ?? join(await mkdtemp(join(root, "npm-")), tarballName(name, version));
      if (!served) {
        await writeFile(pack, bytes);
      }
      fake.packs[`${name}@${version}`] = pack;
      await saveState();
    },

    /** @param {string} tag */
    async tag(tag) {
      fake.tags.push(tag);
      await saveState();
    },

    /** @param {string} tag @param {string[]} [assets] */
    async release(tag, assets = []) {
      fake.releases[tag] = { assets };
      await saveState();
    },

    /** Makes `npm publish` fail for this tarball file name. @param {string} file */
    async failPublish(file) {
      fake.publishFails.push(file);
      await saveState();
    },

    /** The fake GitHub's current state. */
    async github() {
      return /** @type {typeof fake} */ (JSON.parse(await readFile(stateFile, "utf8")));
    },

    /** @param {string} name @param {string} version */
    polls: (name, version) => polls.get(`${name}@${version}`) ?? [],

    /** Every call to the fake npm and gh, in order. @returns {Promise<Call[]>} */
    async calls() {
      const lines = (await readFile(join(state, "calls.ndjson"), "utf8")).split("\n");
      return lines.filter(Boolean).map((line) => JSON.parse(line));
    },

    /**
     * Runs a script from the workspace, as the workflow does, and resolves
     * with its exit code, output and the $GITHUB_OUTPUT it wrote.
     *
     * @param {string} script
     * @param {string[]} args
     * @param {Record<string, string>} [env]
     * @returns {Promise<Run>}
     */
    async run(script, args, env = {}) {
      const output = join(await mkdtemp(join(root, "output-")), "github-output");
      await writeFile(output, "");
      const base = { ...gitEnv };
      // Nothing from the developer's or CI's environment that the scripts read.
      for (const name of [
        "PUBLISHED_RECORD",
        "PUBLISH_PLAN",
        "CHANGESETS_OUTPUT",
        "NPM_PUBLISH_COMMAND",
        "GH_TOKEN",
      ]) {
        delete base[name];
      }
      const start = Date.now();
      const result = await new Promise((resolve) => {
        execFile(
          process.execPath,
          [script, ...args],
          {
            cwd: workspace,
            encoding: "utf8",
            env: {
              ...base,
              ...TIMING,
              PATH: `${bin}:${process.env["PATH"]}`,
              FAKE_STATE: state,
              GITHUB_REPOSITORY: "ie-huss-martinez/sdk-core",
              GITHUB_OUTPUT: output,
              NPM_REGISTRY_URL: `http://127.0.0.1:${port}/`,
              ...env,
            },
          },
          (error, stdout, stderr) => {
            resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
          },
        );
      });
      return { ...result, output: await readFile(output, "utf8"), ms: Date.now() - start };
    },

    async close() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await rm(root, { recursive: true, force: true });
    },
  };
  return sandbox;
}

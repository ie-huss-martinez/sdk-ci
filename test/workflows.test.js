// Checks the rules for workflows and actions in AGENTS.md that a test can
// check: every action is pinned to a full commit SHA with its version in a
// comment, and no shell script contains a `${{ }}` expression.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every workflow, and every composite action's action.yml. */
async function files() {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (
        /^action\.ya?ml$/.test(entry.name) ||
        (/\.ya?ml$/.test(entry.name) && relative(ROOT, dir) === join(".github", "workflows"))
      ) {
        found.push(path);
      }
    }
  }
  await walk(ROOT);
  return found.map((path) => relative(ROOT, path)).sort();
}

/**
 * The steps of a workflow's jobs or a composite action, each with the source
 * line of its `uses:` value, comment included.
 *
 * @param {string} file
 */
async function steps(file) {
  const text = await readFile(join(ROOT, file), "utf8");
  const lines = text.split("\n");
  const document = parseDocument(text);
  const data = document.toJS();
  const jobs = data.jobs ? Object.values(data.jobs) : [{ steps: data.runs?.steps ?? [] }];
  /** @type {Array<{ uses?: string, run?: string, line?: string, job?: string }>} */
  const result = [];
  for (const job of jobs) {
    // A job that calls a reusable workflow has `uses:` itself.
    if (job.uses) {
      result.push({ uses: job.uses, line: lines.find((line) => line.includes(job.uses)) });
    }
    for (const step of job.steps ?? []) {
      result.push({
        ...step,
        line: step.uses ? lines.find((line) => line.includes(`uses: ${step.uses}`)) : undefined,
      });
    }
  }
  return result;
}

describe("workflows and actions", async () => {
  const all = await files();

  it("exist", () => {
    expect(all).toContain(".github/workflows/pr-title.yml");
  });

  describe.each(all)("%s", (file) => {
    it("pins every action to a full commit SHA, with its version in a comment", async () => {
      for (const step of await steps(file)) {
        if (!step.uses || step.uses.startsWith("./")) {
          continue;
        }
        expect(step.uses, `${file}: ${step.uses}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(step.line, `${file}: ${step.uses} needs a "# vX.Y.Z" comment`).toMatch(
          /@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/,
        );
      }
    });

    it("keeps expressions out of shell scripts", async () => {
      // Inputs and event data reach a script through `env:` only, so they're
      // never interpreted as shell code.
      for (const step of await steps(file)) {
        if (step.run) {
          expect(step.run, `${file}: a run: script contains \${{ }}`).not.toContain("${{");
        }
      }
    });
  });
});

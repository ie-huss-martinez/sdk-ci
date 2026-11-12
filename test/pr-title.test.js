// Checks that the pr-title action agrees with sdk-config's commitlint preset,
// which the same rules come from: a pull request title becomes the squash
// commit that commitlint would check. These tests moved here from sdk-config
// when the check became this action.
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PR_TITLE_MAX_LENGTH, SUBJECT_PATTERN, TYPES } from "@hussmartinez/sdk-config/commitlint";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ACTION = fileURLToPath(new URL("../pr-title/action.yml", import.meta.url));

async function steps() {
  return parse(await readFile(ACTION, "utf8")).runs.steps;
}

describe("the pr-title action's semantic check", () => {
  it("uses the same types and subject rule as the commitlint preset", async () => {
    const semantic = (await steps()).find((step) =>
      String(step.uses).startsWith("amannn/action-semantic-pull-request@"),
    );

    expect(semantic.with.types.split("\n").filter(Boolean)).toEqual(TYPES);
    expect(semantic.with.subjectPattern).toBe(SUBJECT_PATTERN.source);
  });
});

describe("the pr-title action's length check", () => {
  /**
   * Runs the length step with bash, with the step's own environment and
   * nothing inherited, as the runner does.
   *
   * @param {string} title
   * @param {Record<string, string>} [overrides] Environment changes, to test
   *   what the step's settings protect against.
   */
  async function checkTitle(title, overrides = {}) {
    const step = (await steps()).find((candidate) => candidate.name === "Check the title length");
    /** @type {Record<string, string>} */
    const stepEnv = Object.fromEntries(
      Object.entries(step.env)
        .filter(([, value]) => !String(value).includes("${{"))
        .map(([name, value]) => [name, String(value)]),
    );
    const cwd = await mkdtemp(join(tmpdir(), "hm-pr-title-"));
    try {
      const result = spawnSync("bash", ["-e", "-c", step.run], {
        cwd,
        encoding: "utf8",
        env: { PATH: process.env["PATH"], ...stepEnv, ...overrides, TITLE: title },
      });
      return { stepEnv, status: result.status, stdout: result.stdout, files: await readdir(cwd) };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  it("uses the preset's pull request title limit and a UTF-8 locale", async () => {
    const { stepEnv } = await checkTitle("docs: x");

    expect(stepEnv["MAX_LENGTH"]).toBe(String(PR_TITLE_MAX_LENGTH));
    expect(stepEnv["LC_ALL"]).toMatch(/\.UTF-8$/i);
  });

  it("accepts a title at the limit and rejects one over it", async () => {
    const fits = `docs: ${"a".repeat(PR_TITLE_MAX_LENGTH - 6)}`;

    await expect(checkTitle(fits)).resolves.toMatchObject({ status: 0 });
    const tooLong = await checkTitle(`${fits}a`);
    expect(tooLong.status).toBe(1);
    expect(tooLong.stdout).toContain(`has ${PR_TITLE_MAX_LENGTH + 1} characters`);
  });

  describe("with multibyte characters", () => {
    const title = `docs: ${"é".repeat(PR_TITLE_MAX_LENGTH - 6)}`;

    it("counts characters, not bytes", async () => {
      await expect(checkTitle(title)).resolves.toMatchObject({ status: 0 });
    });

    it("would count bytes without the step's locale", async () => {
      const result = await checkTitle(title, { LC_ALL: "C" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`has ${2 * PR_TITLE_MAX_LENGTH - 6} characters`);
    });
  });

  it("never runs the title as code", async () => {
    const result = await checkTitle('docs: $(touch pwned) `touch pwned2` "; touch pwned3; "');

    expect(result.status).toBe(0);
    expect(result.files).toEqual([]);
  });
});

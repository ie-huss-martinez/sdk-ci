// Checks the marker the action_path fixture's script writes: that it ran
// from this repository's copy of the fixture, with its argument.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [marker] = process.argv.slice(2);
let record;
try {
  record = JSON.parse(readFileSync(marker ?? "", "utf8"));
} catch {
  process.stdout.write(
    "::error::The script that publish-script names through github.action_path never ran.\n",
  );
  process.exit(1);
}
const expected = join(process.env.GITHUB_WORKSPACE ?? "", "test/fixtures/action-path/script.mjs");
if (record.script !== expected || record.args.join(" ") !== "fixture-argument") {
  process.stdout.write(
    `::error::The script ran as ${record.script} with [${record.args}], not as ${expected} with [fixture-argument].\n`,
  );
  process.exit(1);
}
process.stdout.write(`github.action_path resolved to the action's directory: ${record.script}\n`);

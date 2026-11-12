// Run by the action_path fixture's nested changesets/action. Records where it
// ran and its arguments, for the CI step that checks it.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const marker = process.env.ACTION_PATH_MARKER;
if (!marker) {
  process.stderr.write("ACTION_PATH_MARKER isn't set.\n");
  process.exit(1);
}
writeFileSync(
  marker,
  JSON.stringify({ script: fileURLToPath(import.meta.url), args: process.argv.slice(2) }),
);
process.stdout.write(`The action_path fixture's script ran: ${fileURLToPath(import.meta.url)}\n`);

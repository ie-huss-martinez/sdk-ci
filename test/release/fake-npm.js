// A fake `npm` for the release script tests. `pack <spec>` copies the tarball
// that state.packs maps the spec to, and `publish` fails for the tarballs in
// state.publishFails. Every call is logged to $FAKE_STATE/calls.ndjson.
import { appendFileSync, copyFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const dir = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.ndjson"), `${JSON.stringify({ tool: "npm", args })}\n`);
const command = args[0] === "stage" ? args.slice(0, 2).join(" ") : args[0];

if (command === "pack") {
  const source = state.packs[args[1]];
  if (!source) {
    process.stderr.write(`npm error 404 ${args[1]} is not in this registry\n`);
    process.exit(1);
  }
  copyFileSync(source, join(args[args.indexOf("--pack-destination") + 1], basename(source)));
} else if (command === "publish" || command === "stage publish") {
  const tarball = args[command === "publish" ? 1 : 2];
  if (state.publishFails.includes(basename(tarball))) {
    process.stderr.write("npm error code E403\n");
    process.exit(1);
  }
} else {
  process.stderr.write(`fake npm: unsupported call: ${args.join(" ")}\n`);
  process.exit(2);
}

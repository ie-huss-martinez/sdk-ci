// A fake `gh` for the release script tests. It supports only the calls the
// scripts make, keeps releases and tags in $FAKE_STATE/state.json, and logs
// every call to $FAKE_STATE/calls.ndjson.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const dir = process.env.FAKE_STATE;
const file = join(dir, "state.json");
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.ndjson"), `${JSON.stringify({ tool: "gh", args })}\n`);
const save = () => writeFileSync(file, JSON.stringify(state));
const option = (name) => args[args.indexOf(name) + 1];

if (args[0] === "api") {
  const tag = args[1].split("/git/matching-refs/tags/")[1];
  const refs = state.tags.filter((t) => t.startsWith(tag)).map((t) => ({ ref: `refs/tags/${t}` }));
  process.stdout.write(JSON.stringify(refs));
} else if (args[0] === "release" && args[1] === "view") {
  const release = state.releases[args[2]];
  if (!release) {
    process.stderr.write("release not found\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ assets: release.assets.map((name) => ({ name })) }));
} else if (args[0] === "release" && args[1] === "create") {
  const tag = args[2];
  if (args.includes("--verify-tag") && !state.tags.includes(tag)) {
    process.stderr.write(`tag ${tag} doesn't exist\n`);
    process.exit(1);
  }
  state.releases[tag] = { assets: [], notes: readFileSync(option("--notes-file"), "utf8") };
  save();
} else if (args[0] === "release" && args[1] === "upload") {
  const release = state.releases[args[2]];
  if (!release) {
    process.stderr.write("release not found\n");
    process.exit(1);
  }
  const files = args.slice(3, args.indexOf("--repo"));
  release.assets = [...new Set([...release.assets, ...files.map((f) => basename(f))])];
  save();
} else {
  process.stderr.write(`fake gh: unsupported call: ${args.join(" ")}\n`);
  process.exit(2);
}

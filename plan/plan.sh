#!/usr/bin/env bash
# Lists the versions not yet on npm in $RUNNER_TEMP/publish-plan.json, and
# sets the step output `pending` to whether there are any. Shared by the plan
# and publish actions.
set -euo pipefail
plan="$RUNNER_TEMP/publish-plan.json"
pnpm changeset publish-plan --output "$plan"
# Node rather than jq: the release's verify job runs this in the browser test
# image, which has no jq (ADR 0025, in sdk-core).
count=$(node -e 'const { plan } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(plan.flat().filter((step) => step.kind === "publish").length);' "$plan")
echo "Versions to publish: $count"
echo "pending=$([ "$count" -gt 0 ] && echo true || echo false)" >> "$GITHUB_OUTPUT"

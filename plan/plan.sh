#!/usr/bin/env bash
# Lists the versions not yet on npm in $RUNNER_TEMP/publish-plan.json, and
# sets the step output `pending` to whether there are any. Shared by the plan
# and publish actions.
set -euo pipefail
plan="$RUNNER_TEMP/publish-plan.json"
pnpm changeset publish-plan --output "$plan"
count=$(jq '[.plan[][] | select(.kind == "publish")] | length' "$plan")
echo "Versions to publish: $count"
echo "pending=$([ "$count" -gt 0 ] && echo true || echo false)" >> "$GITHUB_OUTPUT"

# Changelog

Each release of sdk-ci, newest first. A repository adopts one by pinning its full commit SHA, with the version in a comment; Dependabot proposes each new one. See the README for what major, minor and patch mean here.

## v1.1.0

The `changeset` check no longer asks for a changeset when only dev-only fields of a published package's `package.json` changed: `devDependencies`, `scripts`, `packageManager` and `devEngines` ([ADR 0027](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0027-dev-only-package-json-changes-need-no-changeset.md), in sdk-core). Dependabot's development updates now pass without an empty changeset.

- **What still counts:** any other field, including `dependencies`, `engines`, `exports`, `version` and `private`, and any field the list doesn't name, as well as a `package.json` that's new or missing at the merge base. A toolchain update that changes what the build ships still deserves a changeset, which the reviewer asks for.
- **How:** before `changeset status`, the action restores, in its own job's working tree only, each `package.json` whose changes are all dev-only, and logs each one. Changesets decides everything else with the repository's own configuration.
- **Tests:** a CI job now runs a fixture with the same shape as `publish`'s publishing step, and shows that `${{ github.action_path }}` works inside a nested action's `with:`.
- **Adopting it:** a minor update with no workflow changes, so the skeleton is unchanged. Update every sdk-ci pin to this release's commit SHA with `# v1.1.0`, as Dependabot proposes.

## v1.0.0

The first release: the family's CI and release steps as composite actions, and the canonical workflow skeleton every repository follows ([ADR 0026](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0026-share-ci-steps-from-sdk-ci.md), in sdk-core). The steps and conditions are sdk-core's, as of its ADRs 0021, 0023 and 0025.

### Actions

- **`pr-title`:** checks that the pull request title is a Conventional Commit with a lowercase subject, of 65 characters or fewer.
- **`image`:** reads the browser test image from `ci/Dockerfile`, requiring exactly one `FROM` line with Microsoft's Playwright image pinned by tag and digest, and outputs it for the verify jobs' container.
- **`verify`:** installs Node, pnpm and the locked dependencies, then runs `pnpm verify`. It caches pnpm's store for pull requests, but not for releases (`cache: "false"`).
- **`check-workflows`:** checks that the repository's workflows match the skeleton of the sdk-ci version they pin, and that every sdk-ci reference uses the same full SHA and version comment. It parses YAML with its own locked dependency, installed with `npm ci --ignore-scripts`.
- **`changeset`:** fails a pull request that changes a published package without a changeset.
- **`version`:** opens or updates the `chore: version packages` pull request with Changesets, using a token from the organisation's release App (`client-id`, `private-key`).
- **`plan`:** lists the package versions not yet on npm, and outputs `pending`.
- **`publish`:** publishes those versions with npm trusted publishing and provenance, only when the release's verify job succeeded (`verified`). It then tags them, creates their GitHub Releases, and attaches each tarball with `SHA256SUMS` and an attestation. It also repairs releases an earlier run left without their files, and waits up to 10 minutes for npm to show a new version. `npm-token` is for a package's first, bootstrap publish only.

### Skeleton

`skeleton/pr-title.yml`, `verify.yml` and `release.yml`: the jobs, permissions, conditions, container and environments every repository keeps, with steps that call the actions above. A repository may add its own jobs, workflows and environment variables.

### Adopting it

Replace `pr-title.yml`, `verify.yml` and `release.yml` with the skeleton, and pin every sdk-ci step to this release's commit SHA with `# v1.0.0`. The `verify` job's `check-workflows` step then confirms that they match. Each package's npm trusted publisher doesn't change, because publishing still runs in the repository's own `release.yml`, in its `npm` environment.

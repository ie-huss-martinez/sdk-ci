# Changelog

Each release of sdk-ci, newest first. A repository adopts one by pinning its full commit SHA, with the version in a comment; Dependabot proposes each new one. See the README for what major, minor and patch mean here.

## v2.1.0

**A feature:** when a verify job fails, its test results are uploaded, so a reviewer can see what failed without running it again. This includes the visual tests' expected, actual and diff images ([ADR 0048](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0048-visual-regression-for-sdk-editors.md), in sdk-core).

- **`verify`** uploads them as the `test-results` artifact, kept for 7 days, when any of its steps fails. By default that's every `test-results/` folder, which is Playwright's, and `.vitest/attachments/`, which is Vitest's, outside `node_modules`. Callers outside the skeleton can choose other paths with the new `results` input.
- **Adopting it:** update every sdk-ci pin to this release's commit SHA with `# v2.1.0`. The skeleton is unchanged from v2.0.0.

## v2.0.1

**A fix:** with v2.0.0, a release's verify job failed at "Plan the release" with `jq: command not found`, because it runs in the browser test image ([ADR 0025](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0025-one-browser-test-image-in-one-place.md), in sdk-core), which has no `jq`. Nothing was published: the publish job refused, as it should.

- **`plan`, shared by the verify, plan and publish actions,** counts the versions to publish with Node instead of `jq`.
- **`verify`, with `pack: "true"`,** checks up front that the image has the tools the pack path uses (`sha256sum`, `cut`, `tar` and `gzip`), and fails naming any that's missing, before running `pnpm verify`.
- **Tests:** CI now runs the verify action's own pack steps in the release's browser test image, as user 1001, against a fixture package, once built and once without `dist/`.
- **Adopting it:** update every sdk-ci pin to this release's commit SHA with `# v2.0.1`. The skeleton is unchanged from v2.0.0, so a repository still on v1 makes v2.0.0's `release.yml` change in the same pull request.

## v2.0.0

**A fix, released as a major version:** every repository must change its `release.yml`. The publish action packed packages it never built, so `@hussmartinez/sdk-core` 0.1.3 and 0.2.0, and `@hussmartinez/ui` 0.1.0 to 0.2.0, were published without `dist/` ([ADR 0041](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0041-publish-the-verified-tarballs.md), in sdk-core). Releases now publish exactly the tarballs that the verify job built, checked and uploaded.

- **`verify`, with the new `pack: "true"`:** after `pnpm verify`, it packs the versions to publish from that build and checks the tarballs. It uploads them as the `release-packs` artifact, and outputs `packs`, the SHA-256 of their publish plan. `pack` needs `cache: "false"`.
- **`publish`, with the new required `packs`:** it no longer builds or packs. It downloads `release-packs`, requires the plan's SHA-256 to equal `packs` and its versions to equal its own plan's, checks the files again, and publishes exactly those tarballs.
- **The guards:**
  - every file a package's `main`, `module`, `types`, `typings`, `bin` and `exports` point to must be in its tarball, or the release fails naming each missing path. This runs in both jobs;
  - `publint --strict` must pass on each tarball, in the verify job only, from the action's own lockfile, so repositories needn't depend on publint.
- **Adopting it:** update every sdk-ci pin to this release's commit SHA with `# v2.0.0`, and change `release.yml`'s verify and publish jobs as the skeleton does. `check-workflows` fails until both are done:

  ```yaml
  verify:
    # …
    outputs:
      packs: ${{ steps.verify.outputs.packs }}
    steps:
      - id: verify
        uses: ie-huss-martinez/sdk-ci/verify@<sha> # v2.0.0
        with:
          cache: "false"
          pack: "true"
  publish:
    # …
    steps:
      - uses: ie-huss-martinez/sdk-ci/publish@<sha> # v2.0.0
        with:
          verified: ${{ needs.verify.result }}
          packs: ${{ needs.verify.outputs.packs }}
          npm-token: ${{ secrets.NPM_TOKEN }}
  ```

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

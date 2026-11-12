# sdk-ci

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Shared CI and release steps for the `@hussmartinez` SDK family, as GitHub composite actions.

Every repository in the family keeps its own `verify.yml` and `release.yml`, with their jobs, permissions, container and environments. Each job's steps come from this repository, pinned by commit SHA:

```yaml
- uses: ie-huss-martinez/sdk-ci/<action>@<full commit SHA> # vX.Y.Z
```

The scripts each action runs live inside it, so a repository always runs exactly the version it pins, and a fix made here reaches every repository through its own Dependabot pull request. The reasoning is in [ADR 0026](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0026-share-ci-steps-from-sdk-ci.md), in `sdk-core`, which also holds the family's [standards](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md).

> Status: no release yet. `v1.0.0` follows `check-workflows` and the canonical job skeleton.

## Actions

Each action checks out the repository itself and runs in a job that the calling repository defines, with that job's permissions, container and environment.

| Action | Job | What it does | Inputs |
|---|---|---|---|
| [`image`](image/action.yml) | `image` | Reads the browser test image from `ci/Dockerfile`, requiring one `FROM` line with Microsoft's Playwright image pinned by tag and digest, and outputs `ref` | `directory` (default `ci`) |
| [`verify`](verify/action.yml) | `verify`, `verify release` | Installs Node from `.node-version`, pnpm and the locked dependencies, then runs `pnpm verify` | `cache` (default `true`; `false` in releases) |
| [`version`](version/action.yml) | `version` | Opens or updates the `chore: version packages` pull request with Changesets, with a token from the release App, and outputs `has-changesets` | `client-id`, `private-key` |
| [`plan`](plan/action.yml) | `plan` | Lists the versions not yet on npm, and outputs `pending` | none |
| [`publish`](publish/action.yml) | `publish` | Publishes those versions with trusted publishing and provenance, only if `verified` is `success`; tags them, creates their GitHub Releases, and attaches each tarball with `SHA256SUMS` and an attestation, also repairing releases an earlier run left unfinished | `verified`, `npm-token` (bootstrap only), `npm-publish-command` (default `publish`) |

`publish` runs in the caller's own `publish` job, in its `npm` environment, so each package's npm trusted publisher keeps matching the caller's `release.yml` ([ADR 0026](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0026-share-ci-steps-from-sdk-ci.md)).

## Development

You need Node 24 (see [`.node-version`](.node-version)) and pnpm. The exact pnpm version is pinned in `package.json`, and pnpm switches to it automatically.

```sh
pnpm install       # also installs the git hooks
pnpm verify        # everything CI runs: Biome, then the tests
pnpm verify:fast   # the tests, which the pre-push hook runs
```

The tests cover:

- the release scripts in `publish/`, end to end through their real command lines, against a fake registry, `npm` and `gh` (`test/release/`);
- the actions' inline scripts and the shared plan script, run with bash against fixtures, and the structure a release's safety depends on (`test/actions.test.js`);
- the rules in [`AGENTS.md`](AGENTS.md) for workflows and actions: every action pinned to a full commit SHA with its version in a comment, and no `${{ }}` expression inside a shell script (`test/workflows.test.js`).

CI also runs the `verify` action on this repository and the `image` action on a fixture, so both are exercised on every pull request.

## Versions

Releases are plain `vX.Y.Z` tags with a GitHub Release. Nothing here is published to npm.

- **Major:** a change that a repository must adapt to, such as a removed or renamed input, or a change to the expected job skeleton.
- **Minor:** a new action or input, compatible with the previous version.
- **Patch:** a fix.

## Licence

[Apache-2.0](LICENSE).

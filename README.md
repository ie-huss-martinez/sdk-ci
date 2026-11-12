# sdk-ci

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Shared CI and release steps for the `@hussmartinez` SDK family, as GitHub composite actions.

Every repository in the family keeps its own `verify.yml` and `release.yml`, with their jobs, permissions, container and environments. Each job's steps come from this repository, pinned by commit SHA:

```yaml
- uses: ie-huss-martinez/sdk-ci/<action>@<full commit SHA> # vX.Y.Z
```

The scripts each action runs live inside it, so a repository always runs exactly the version it pins, and a fix made here reaches every repository through its own Dependabot pull request. The reasoning is in [ADR 0026](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0026-share-ci-steps-from-sdk-ci.md), in `sdk-core`, which also holds the family's [standards](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md).

> Status: no release yet. The actions arrive in the next pull requests, and `v1.0.0` follows them.

## Development

You need Node 24 (see [`.node-version`](.node-version)) and pnpm. The exact pnpm version is pinned in `package.json`, and pnpm switches to it automatically.

```sh
pnpm install       # also installs the git hooks
pnpm verify        # everything CI runs: Biome, then the tests
pnpm verify:fast   # the tests, which the pre-push hook runs
```

The tests include a check of the rules in [`AGENTS.md`](AGENTS.md) for workflows and actions: every action pinned to a full commit SHA with its version in a comment, and no `${{ }}` expression inside a shell script.

## Versions

Releases are plain `vX.Y.Z` tags with a GitHub Release. Nothing here is published to npm.

- **Major:** a change that a repository must adapt to, such as a removed or renamed input, or a change to the expected job skeleton.
- **Minor:** a new action or input, compatible with the previous version.
- **Patch:** a fix.

## Licence

[Apache-2.0](LICENSE).

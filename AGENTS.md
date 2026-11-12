# Working in this repository

This repository is part of the `@hussmartinez` SDK family and is public. Treat it as a showcase: code, commits and pull requests should read as professional work.

It holds the family's shared CI and release steps as composite actions ([ADR 0026](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0026-share-ci-steps-from-sdk-ci.md)). Every repository's verify and release jobs run them, including the release jobs that publish to npm with an OIDC token. A change here reaches every repository's release, so review it with that in mind.

## Before changing anything

- Read [`STANDARDS.md`](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md) in `sdk-core`. It is binding for every repository in the family.
- Check the decision records before changing anything they cover. Family-wide decisions live in [`sdk-core`'s `docs/adr`](https://github.com/ie-huss-martinez/sdk-core/tree/main/docs/adr); decisions specific to this repository live in `docs/adr` here. To change a decision, write a new ADR that supersedes the old one, in the same pull request as the change. A change to a family-wide decision belongs in `sdk-core`, not here.
- The records that matter most here are [0015](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0015-verification-and-releases.md) (verification and releases), [0021](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0021-version-and-release-with-changesets.md) (Changesets and trusted publishing), [0023](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0023-verify-releases-in-an-unprivileged-job.md) (verifying releases in an unprivileged job), [0025](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0025-one-browser-test-image-in-one-place.md) (one browser test image) and [0026](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0026-share-ci-steps-from-sdk-ci.md) (this repository).

## Making changes

- **Pull requests:** work on a branch and open one focused pull request per change. Never push to `main`; it is protected.
- **One pull request at a time:** after opening a pull request, stop and report its link, a short summary and your verification results. Start the next change only once it's merged, from an up-to-date `main`.
- **Never merge your own pull request:** a separate reviewer reads the full diff, verifies it independently, and squash-merges it. An agent that wrote a pull request never reviews or merges it. The family's review and merge rules are in [`sdk-core`'s `CONTRIBUTING.md`](https://github.com/ie-huss-martinez/sdk-core/blob/main/CONTRIBUTING.md#how-pull-requests-are-reviewed).
- **Pull request descriptions:** cover what changed, why, and how it was tested. They can be as detailed as useful, because they don't go into git history.
- **Squash commits:** the merger writes the commit message on `main`. Its title is the pull request title plus `(#N)`, and its body is 2–6 lines of plain prose.
- **Commits:** follow Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:`). The pull request title becomes the squash commit, so write it as a Conventional Commit too, of 65 characters or fewer.
- **Versions:** releases are plain `vX.Y.Z` tags with a GitHub Release, and nothing is published to npm, so there are no changesets. Say in each pull request whether it's a major, minor or patch change for the repositories that use it (see the README).
- **Signing:** commits are signed; don't disable signing.
- **No attribution:** don't add AI or tool attribution to commits or pull requests.
- **ADRs:** add one for any significant decision, meaning anything affecting the actions' interface, every repository's release, or security, or that is hard to reverse.
- **Other repositories:** don't edit them from here. A repository adopts a new version through its own pull request.

## Rules for the actions

These follow from the standards and ADRs, and apply to almost every change here.

- **Least privilege:** an action needs only the permissions its job already grants, and documents them. It never prints a secret or a token, and never adds one to a file in the workspace.
- **Pinned and offline at run time:** every action an action uses is pinned to a full commit SHA. Nothing is downloaded at run time except through those pins and the repository's own locked dependencies.
- **Untrusted input:** inputs and anything read from the event, such as branch names and pull request titles, reach shell commands only through environment variables, never through `${{ }}` inside `run:`.
- **Tested:** every script ships with tests that run its real command line against fakes, as `sdk-core`'s release-script tests do.

## Verifying changes

- **Hooks:** they run automatically: linting and a secret scan on commit, commit message checks, and `pnpm verify:fast` on push. Never use `--no-verify`. If a hook is wrong or too slow, fix it in its own pull request.
- **Before marking a pull request ready,** run the full `pnpm verify` locally and report its results in the description.
- **CI:** it runs `pnpm verify` and checks the pull request title. Both must pass before merging. CI is the final gate, not a substitute for local verification.
- **Never weaken a check to make it pass.** That includes lint rules, the workflow rules test and the supply-chain settings. Fix the cause, or propose the change in its own pull request with an ADR if the rule itself is wrong.

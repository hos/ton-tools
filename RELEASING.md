# Releasing

Both packages are published to [JSR](https://jsr.io) only, never to npm:

| package | directory | tag |
|---|---|---|
| [`@ton/watch`](https://jsr.io/@ton/watch) | `packages/ton-watch` | `ton-watch-v<version>` |
| [`@ton/ls`](https://jsr.io/@ton/ls) | `packages/ton-ls` | `ton-ls-v<version>` |

Pushing a tag runs `.github/workflows/publish.yml`: it checks that the tag matches
the version in `package.json` and `jsr.json`, runs typecheck (ton-watch), lint and
tests, then `bunx jsr publish`, authenticated through GitHub OIDC (no token).

## Steps

1. Bump `version` in the package's `package.json` **and** `jsr.json` (and, for
   ton-watch, `VERSION` in `src/version.ts`). `tests/manifest.test.ts` fails until
   they agree.
2. ton-watch: move the `Unreleased` entries in `CHANGELOG.md` under the new version
   with today's date, and add its link at the bottom.
3. If `@ton/ls` changed in a way ton-watch needs, release `@ton/ls` first: ton-watch
   is published with `@ton/ls` pinned to `^<the version in packages/ton-ls/jsr.json>`
   (the `workspace:*` dependency is rewritten on publish). In particular
   `@ton/watch` 0.1.0 imports `LiteConnection` from `@ton/ls`, so `@ton/ls` 0.0.4
   must be on JSR before `ton-watch-v0.1.0` is tagged.
4. Check the package: `cd packages/<dir> && bunx jsr publish --dry-run --allow-dirty`
   (no slow-types or excluded-module errors; the listed files are what ships).
5. Commit, then tag and push:

   ```sh
   git tag ton-watch-v0.1.0
   git push origin main ton-watch-v0.1.0
   ```

A failed run publishes nothing; fix, move the tag (`git tag -f`, `git push -f origin
<tag>`) and push again. A published version can never be replaced, only yanked on
jsr.io, so release a new patch version instead.

## One-time setup on jsr.io

Done once per package by a member of the `@ton` scope:

1. Create the package: jsr.io → `@ton` scope → **Create package** → name `watch`
   (`@ton/ls` already exists).
2. Link the repository so OIDC publishing is allowed: on each package's
   **Settings** page, under **GitHub Repository**, link `hos/ton-tools`. Without it
   the workflow's publish step is rejected.

Publishing by hand still works (`bunx jsr publish` opens a browser to authorize)
but should not be needed.

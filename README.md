# ton-tools

TypeScript libraries for building on [TON](https://ton.org) straight from
liteservers, without a third-party API in between. Published on
[JSR](https://jsr.io/@ton).

| package | what it does |
|---|---|
| [`@ton/watch`](packages/ton-watch) · [JSR](https://jsr.io/@ton/watch) | Embeddable transaction indexer for a set of addresses: fetches from liteservers in any order, hands transactions to your code strictly in chain order, never past a gap. Library, CLI and service (Postgres, webhooks, metrics). |
| [`@ton/ls`](packages/ton-ls) · [JSR](https://jsr.io/@ton/ls) | Picks working liteservers out of a network config by benchmarking them, and provides a liteserver connection that closes cleanly. |

```sh
bunx jsr add @ton/watch   # Bun
npx jsr add @ton/ls       # Node.js (also Deno and Bun)
```

Each package's README covers usage; `@ton/watch` keeps the full reference, its
stability policy and benchmarks in [`docs/`](packages/ton-watch/docs).

## Development

A [Bun](https://bun.sh) workspace. Commands run inside a package directory:

```sh
bun install                    # at the root
cd packages/ton-watch
bun test                       # tests (PGlite; set TEST_DATABASE_URL for real Postgres)
bun run typecheck
bun run lint                   # Biome; `bun run format` to fix
```

CI runs lint, typecheck and tests on every pull request. Releases go to JSR from a
version tag; see [RELEASING.md](RELEASING.md).

## License

[MIT](license.md)

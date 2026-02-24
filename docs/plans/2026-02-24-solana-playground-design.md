# Solana Playground Design

**Date:** 2026-02-24
**Location:** `/Users/work/code/zama/solana-playground`

## Purpose

A sandbox repository for fast Solana experimentation. Supports both on-chain program development (Anchor) and client-side scripting (`@solana/kit`). Designed for quick investigations (e.g., entropy gathering from smart contracts) with minimal boilerplate per experiment.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Structure | Flat Anchor workspace | Simplest; one `anchor build`, cargo deduplicates deps |
| Package manager | Bun | Fast runtime + pkg manager + test runner in one |
| On-chain framework | Anchor 0.31 | Latest stable, IDL gen, event-cpi support |
| Rust testing | Mollusk | Fastest feedback, in-process SVM |
| TS SDK | `@solana/kit` | Modern functional API, tree-shakeable |
| Linting/formatting | Biome | Fast, replaces ESLint + Prettier |
| Git hooks | Pre-commit (from solana-awesome guardrails) | Typos, fmt, clippy, biome checks |

## Repository Structure

```
solana-playground/
├── Anchor.toml                       # Anchor 0.31, cluster configs
├── Cargo.toml                        # workspace: programs/*, lib/*
├── package.json                      # bun, @solana/kit, biome
├── biome.json
├── .pre-commit-config.yaml
├── .typos.toml
├── scripts/
│   ├── pre-commit-checks.sh
│   └── pre-push-checks.sh
├── lib/
│   └── common/                       # Shared Rust crate
│       ├── Cargo.toml
│       └── src/lib.rs
├── programs/
│   └── example/                      # Starter experiment
│       ├── Cargo.toml
│       └── src/lib.rs
├── tests/                            # TS integration tests (bun test)
│   ├── helpers/
│   │   └── setup.ts                  # RPC setup, airdrop, cluster selection
│   └── example.test.ts
└── keys/                             # Local keypairs (gitignored)
```

## Dependencies

### Rust / On-chain

- `anchor-lang` 0.31, `anchor-spl` 0.31
- `solana-program` 2.1 (via Anchor)
- `mollusk-svm` for Rust unit tests
- `lib/common` shared crate

### TypeScript / Off-chain

- `bun` (runtime, package manager, test runner)
- `@solana/kit` (RPC, transactions, keypairs)
- `@coral-xyz/anchor` 0.31 (IDL-based program interaction)
- `biome` (format + lint)

## Cluster Configuration

```toml
[provider]
cluster = "localnet"
wallet = "keys/local.json"

[clusters]
localnet = "http://127.0.0.1:8899"
devnet = "https://api.devnet.solana.com"
testnet = "https://api.testnet.solana.com"
```

TS scripts accept `SOLANA_CLUSTER` env var or `--cluster` flag, resolved in `tests/helpers/setup.ts`.

## Workflow: Adding an Experiment

1. Create program: `anchor init programs/<name> --no-git`
2. Add to Cargo workspace members
3. Write on-chain code, use `lib/common` for shared utils
4. Add Mollusk unit tests in the program crate
5. Add TS integration tests in `tests/<name>.test.ts`
6. Optionally add scripts in `scripts/<name>.ts`

### Commands

- `cargo test` — all Mollusk tests
- `bun test` — all TS integration tests
- `anchor build` — build all programs
- `anchor deploy --provider.cluster devnet` — deploy to devnet

## Starter Example Program

`programs/example/` includes:
- `initialize` instruction: stores a value in a PDA
- `read_clock` instruction: reads Clock sysvar, logs slot + timestamp
- Mollusk unit test for account creation
- TS integration test demonstrating `@solana/kit` usage

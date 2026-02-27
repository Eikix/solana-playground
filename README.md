# Solana Playground

A sandbox repository for fast Solana experimentation. Supports on-chain program development (Anchor) and client-side scripting (`@solana/kit`). Designed for quick investigations with minimal boilerplate per experiment.

## What's Inside

### Programs

| Program | Description | Framework |
|---|---|---|
| [`programs/example`](programs/example) | Starter experiment demonstrating PDA accounts and Clock sysvar reading | Anchor 0.31 |
| [`programs/recent-blockhash`](programs/recent-blockhash) | Zero-copy SlotHashes sysvar reader that extracts recent blockhashes without full deserialization | Anchor 0.31 |

### Scripts & Tools

| Script | Description |
|---|---|
| [`scripts/reorg-monitor.ts`](scripts/reorg-monitor.ts) | Real-time Solana fork/reorg statistics monitor with SQLite persistence, dual WebSocket subscriptions, and a live terminal dashboard |
| [`scripts/run-recent-blockhash.ts`](scripts/run-recent-blockhash.ts) | Sends a transaction to the recent-blockhash program and displays logs with cross-referenced block data |
| [`scripts/pre-commit-checks.sh`](scripts/pre-commit-checks.sh) | Fast pre-commit validation (cargo fmt, typecheck, biome) |
| [`scripts/pre-push-checks.sh`](scripts/pre-push-checks.sh) | Heavier pre-push validation (clippy, cargo test, anchor build, bun test) |

### Shared Libraries

| Crate | Description |
|---|---|
| [`lib/common`](lib/common) | Shared Rust error codes and utilities used across programs |

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Solana CLI](https://docs.solanalabs.com/cli/install) (v2.1+)
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) (v0.31.1)
- [Bun](https://bun.sh/) (runtime, package manager, and test runner)

### Setup

```bash
# Install JS dependencies
bun install

# Install git hooks
pre-commit install --hook-type pre-commit --hook-type pre-push

# Build all programs
anchor build

# Run all tests
cargo test --all    # Rust / Mollusk unit tests
bun test            # TypeScript integration tests
```

## Commands

| Command | What it does |
|---|---|
| `anchor build` | Build all programs to `target/deploy/*.so` |
| `anchor deploy` | Deploy to the configured cluster |
| `anchor deploy --provider.cluster devnet` | Deploy to devnet |
| `cargo test --all` | Run all Rust unit tests (Mollusk SVM) |
| `cargo test -p example` | Run tests for a single program |
| `bun test` | Run TypeScript integration tests |
| `bun run lint` | Lint with Biome |
| `bun run format` | Format with Biome |
| `bun run format:check` | Check formatting without writing |
| `bun run typecheck` | TypeScript type checking |
| `bun run monitor` | Start the reorg monitor (set `SOLANA_CLUSTER` first) |

### Reorg Monitor

```bash
SOLANA_CLUSTER=mainnet-beta bun run monitor            # live dashboard
SOLANA_CLUSTER=devnet      bun run monitor --verify     # verification/backtest mode
SOLANA_CLUSTER=devnet      bun run monitor --reset      # clear accumulated stats
```

### Running the Recent-Blockhash Script

```bash
SOLANA_CLUSTER=localnet bun run scripts/run-recent-blockhash.ts
```

## Cluster Support

All TypeScript scripts and tests accept a `SOLANA_CLUSTER` environment variable:

| Cluster | RPC URL |
|---|---|
| `localnet` (default) | `http://127.0.0.1:8899` |
| `devnet` | `https://api.devnet.solana.com` |
| `testnet` | `https://api.testnet.solana.com` |
| `mainnet-beta` | `https://api.mainnet-beta.solana.com` |

For Anchor CLI commands, use `--provider.cluster <cluster>`.

## Quality Gates

Quality is enforced by pre-commit hooks (no CI pipeline). Install them once and they run automatically:

- **Pre-commit** (fast): `cargo fmt --check`, `tsc --noEmit`, `biome check`, `biome format --check`
- **Pre-push** (thorough): all of the above plus `cargo clippy`, `cargo test`, `anchor build`, `bun test`

Run all checks manually:

```bash
pre-commit run --all-files          # pre-commit checks
pre-commit run --hook-stage push    # pre-push checks
```

## Tech Stack

| Layer | Tool | Role |
|---|---|---|
| On-chain framework | Anchor 0.31 | Program scaffolding, IDL generation, events |
| Rust testing | Mollusk SVM | In-process SVM execution for fast unit tests |
| Client SDK | `@solana/kit` | Modern RPC, transactions, keypairs |
| Anchor client | `@coral-xyz/anchor` 0.31 | IDL-based program interaction |
| Runtime & package manager | Bun | Fast JS runtime, test runner, package manager |
| Linting & formatting | Biome | Replaces ESLint + Prettier |
| Git hooks | pre-commit | Automated quality checks |
| Typo checking | typos | Catches spelling mistakes in source |

## Project Structure

```
solana-playground/
├── Anchor.toml                  # Anchor config, cluster settings, program IDs
├── Cargo.toml                   # Cargo workspace (programs/*, lib/*)
├── package.json                 # Bun scripts, JS dependencies
├── tsconfig.json                # TypeScript compiler config
├── biome.json                   # Linter and formatter config
├── .pre-commit-config.yaml      # Git hook definitions
├── .typos.toml                  # Typo checker config
│
├── programs/
│   ├── example/                 # Starter experiment (PDA + Clock sysvar)
│   └── recent-blockhash/        # SlotHashes zero-copy reader
│
├── lib/
│   └── common/                  # Shared Rust crate (error codes, utilities)
│
├── tests/
│   ├── helpers/setup.ts         # RPC/WS helpers, cluster resolution
│   └── example.test.ts          # Integration test example
│
├── scripts/
│   ├── reorg-monitor.ts         # Fork/reorg statistics monitor
│   ├── run-recent-blockhash.ts  # Program execution script
│   ├── pre-commit-checks.sh     # Fast pre-commit validation
│   └── pre-push-checks.sh      # Thorough pre-push validation
│
├── docs/plans/                  # Design documents and implementation plans
└── keys/                        # Local keypairs (gitignored)
```

## Adding a New Experiment

See [AGENT.md](AGENT.md) for a contributor checklist covering new programs, documentation, and quality gates.

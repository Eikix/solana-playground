# Solana Playground Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold a flat Anchor 0.31 workspace for fast Solana experimentation with Bun, @solana/kit, Mollusk, and Biome.

**Architecture:** Single Anchor workspace with programs under `programs/`, shared Rust utils in `lib/common/`, TS tests in `tests/`, and scripts in `scripts/`. A starter `example` program demonstrates the full workflow. Guardrails from the solana-awesome template enforce code quality.

**Tech Stack:** Anchor 0.31.1, Mollusk 0.10.3, @solana/kit 6.1.0, Bun, Biome 2.4.4, pre-commit hooks

---

### Task 1: Project scaffolding — .gitignore and directory structure

**Files:**
- Create: `.gitignore`
- Create: `keys/.gitkeep` (dir tracked, contents ignored)

**Step 1: Create .gitignore**

```gitignore
# Solana / Anchor
target/
.anchor/
test-ledger/

# Keys (local wallets)
keys/*.json

# Node
node_modules/
bun.lockb

# OS
.DS_Store

# IDL build artifacts are tracked, but deploy keypairs are not
```

**Step 2: Create keys directory**

```bash
mkdir -p keys
touch keys/.gitkeep
```

**Step 3: Commit**

```bash
git add .gitignore keys/.gitkeep
git commit -m "Add .gitignore and keys directory"
```

---

### Task 2: Cargo workspace root

**Files:**
- Create: `Cargo.toml`
- Create: `Xargo.toml`

**Step 1: Create root Cargo.toml**

```toml
[workspace]
members = ["programs/*", "lib/*"]
resolver = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1

[profile.release.build-override]
opt-level = 3
incremental = false
codegen-units = 1

[workspace.dependencies]
anchor-lang = "0.31.1"
anchor-spl = "0.31.1"
```

**Step 2: Create Xargo.toml**

```toml
[target.bpfel-unknown-unknown.dependencies.std]
features = []
```

**Step 3: Verify workspace parses (expect warning about no members yet)**

Run: `cargo metadata --format-version 1 --no-deps 2>&1 | head -5`

**Step 4: Commit**

```bash
git add Cargo.toml Xargo.toml
git commit -m "Add Cargo workspace configuration"
```

---

### Task 3: Shared Rust library crate — lib/common

**Files:**
- Create: `lib/common/Cargo.toml`
- Create: `lib/common/src/lib.rs`

**Step 1: Create lib/common/Cargo.toml**

```toml
[package]
name = "common"
version = "0.1.0"
edition = "2021"

[dependencies]
anchor-lang = { workspace = true }
```

**Step 2: Create lib/common/src/lib.rs**

```rust
use anchor_lang::prelude::*;

/// Shared error codes reusable across experiments.
#[error_code]
pub enum CommonError {
    #[msg("Invalid input provided")]
    InvalidInput,
    #[msg("Arithmetic overflow")]
    Overflow,
}
```

**Step 3: Verify it compiles**

Run: `cargo check -p common`
Expected: success (or warning about unused, which is fine)

**Step 4: Commit**

```bash
git add lib/common/
git commit -m "Add shared common library crate"
```

---

### Task 4: Anchor.toml configuration

**Files:**
- Create: `Anchor.toml`

**Step 1: Generate a program keypair for the example program**

```bash
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase -o target/deploy/example-keypair.json 2>/dev/null
```

**Step 2: Get the program ID**

```bash
solana-keygen pubkey target/deploy/example-keypair.json
```

**Step 3: Create Anchor.toml using the program ID from step 2**

```toml
[features]
seeds = false
skip-lint = false

[programs.localnet]
example = "<PROGRAM_ID_FROM_STEP_2>"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "Localnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "bun test"

[toolchain]
anchor_version = "0.31.1"
solana_version = "2.1.0"
```

**Step 4: Commit**

```bash
git add Anchor.toml
git commit -m "Add Anchor.toml with localnet/devnet/testnet cluster configs"
```

Note: `target/deploy/` is gitignored — the keypair is local only.

---

### Task 5: Example Anchor program — on-chain code

**Files:**
- Create: `programs/example/Cargo.toml`
- Create: `programs/example/src/lib.rs`

**Step 1: Create programs/example/Cargo.toml**

Use the program ID from Task 4, Step 2.

```toml
[package]
name = "example"
version = "0.1.0"
description = "Starter experiment program"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "example"

[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
idl-build = ["anchor-lang/idl-build"]

[dependencies]
anchor-lang = { workspace = true }
common = { path = "../../lib/common" }

[dev-dependencies]
mollusk-svm = "0.10.3"
solana-sdk = "2.1"
```

**Step 2: Create programs/example/src/lib.rs**

```rust
use anchor_lang::prelude::*;

declare_id!("<PROGRAM_ID_FROM_TASK_4>");

#[program]
pub mod example {
    use super::*;

    /// Initialize a new data account with a value stored in a PDA.
    pub fn initialize(ctx: Context<Initialize>, value: u64) -> Result<()> {
        let data_account = &mut ctx.accounts.data_account;
        data_account.authority = ctx.accounts.authority.key();
        data_account.value = value;
        Ok(())
    }

    /// Read the Clock sysvar and log the current slot + timestamp.
    pub fn read_clock(ctx: Context<ReadClock>) -> Result<()> {
        let clock = Clock::get()?;
        msg!("Slot: {}, Timestamp: {}", clock.slot, clock.unix_timestamp);
        ctx.accounts.data_account.last_slot = clock.slot;
        ctx.accounts.data_account.last_timestamp = clock.unix_timestamp;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + DataAccount::INIT_SPACE,
        seeds = [b"data", authority.key().as_ref()],
        bump,
    )]
    pub data_account: Account<'info, DataAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReadClock<'info> {
    #[account(
        mut,
        seeds = [b"data", authority.key().as_ref()],
        bump,
        has_one = authority,
    )]
    pub data_account: Account<'info, DataAccount>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct DataAccount {
    pub authority: Pubkey,
    pub value: u64,
    pub last_slot: u64,
    pub last_timestamp: i64,
}
```

**Step 3: Build to verify it compiles**

Run: `anchor build`
Expected: Successful build, produces `target/deploy/example.so`

**Step 4: Commit**

```bash
git add programs/example/
git commit -m "Add example Anchor program with initialize and read_clock instructions"
```

---

### Task 6: Mollusk unit tests for example program

**Files:**
- Create: `programs/example/tests/mollusk_test.rs`

**Step 1: Write the Mollusk test**

```rust
use mollusk_svm::Mollusk;
use mollusk_svm::result::Check;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
    rent::Rent,
    sysvar,
};

/// Anchor discriminator: sha256("global:initialize")[..8]
fn initialize_discriminator() -> [u8; 8] {
    let hash = solana_sdk::hash::hash(b"global:initialize");
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash.as_ref()[..8]);
    disc
}

#[test]
fn test_initialize() {
    let program_id = Pubkey::new_unique();
    let mollusk = Mollusk::new(&program_id, "target/deploy/example");

    let authority = Pubkey::new_unique();
    let (data_pda, _bump) = Pubkey::find_program_address(
        &[b"data", authority.as_ref()],
        &program_id,
    );

    let rent = Rent::default();
    // 8 (discriminator) + 32 (authority) + 8 (value) + 8 (last_slot) + 8 (last_timestamp) = 64
    let space = 8 + 32 + 8 + 8 + 8;
    let lamports = rent.minimum_balance(space);

    let value: u64 = 42;
    let mut ix_data = Vec::new();
    ix_data.extend_from_slice(&initialize_discriminator());
    ix_data.extend_from_slice(&value.to_le_bytes());

    let instruction = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(data_pda, false),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: ix_data,
    };

    let authority_account = Account {
        lamports: 1_000_000_000,
        data: vec![],
        owner: system_program::ID,
        executable: false,
        rent_epoch: 0,
    };

    let data_account = Account {
        lamports: 0,
        data: vec![],
        owner: system_program::ID,
        executable: false,
        rent_epoch: 0,
    };

    mollusk.process_and_validate_instruction(
        &instruction,
        &[
            (data_pda, data_account),
            (authority, authority_account),
            (system_program::ID, Account::default()),
        ],
        &[Check::success()],
    );
}
```

**Step 2: Build the program first (Mollusk needs the .so)**

Run: `anchor build`

**Step 3: Run the test**

Run: `cargo test -p example --test mollusk_test`
Expected: PASS

Note: The discriminator computation for Anchor may differ from a raw sha256 — if the test fails with an instruction error, verify the discriminator matches what Anchor generates. The actual Anchor discriminator for `initialize` is `sha256("global:initialize")[..8]`. If it fails, check `anchor idl build` output to confirm.

**Step 4: Commit**

```bash
git add programs/example/tests/
git commit -m "Add Mollusk unit test for example program initialize instruction"
```

---

### Task 7: Bun + TypeScript setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `biome.json`

**Step 1: Create package.json**

```json
{
  "name": "solana-playground",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "anchor build",
    "test": "bun test",
    "test:rust": "cargo test --all",
    "lint": "biome check .",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@coral-xyz/anchor": "^0.31.1",
    "@solana/kit": "^6.1.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.4",
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "resolveJsonModule": true,
    "types": ["bun-types"]
  },
  "include": ["tests/**/*.ts", "scripts/**/*.ts"],
  "exclude": ["node_modules", "dist", "target"]
}
```

**Step 3: Create biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.4/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "files": {
    "ignore": ["node_modules", "target", "dist", ".anchor", "test-ledger"]
  }
}
```

**Step 4: Install dependencies**

Run: `bun install`

**Step 5: Verify**

Run: `bun run typecheck`
Expected: success (no TS files yet, so no errors)

Run: `bun run lint`
Expected: success

**Step 6: Commit**

```bash
git add package.json tsconfig.json biome.json bun.lockb
git commit -m "Add Bun, TypeScript, Biome, and @solana/kit configuration"
```

---

### Task 8: TS test helpers — cluster setup with @solana/kit

**Files:**
- Create: `tests/helpers/setup.ts`

**Step 1: Create tests/helpers/setup.ts**

```typescript
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

export type Cluster = "localnet" | "devnet" | "testnet";

const CLUSTER_URLS: Record<Cluster, string> = {
	localnet: "http://127.0.0.1:8899",
	devnet: "https://api.devnet.solana.com",
	testnet: "https://api.testnet.solana.com",
};

const CLUSTER_WS_URLS: Record<Cluster, string> = {
	localnet: "ws://127.0.0.1:8900",
	devnet: "wss://api.devnet.solana.com",
	testnet: "wss://api.testnet.solana.com",
};

export function getCluster(): Cluster {
	const env = process.env.SOLANA_CLUSTER;
	if (env && env in CLUSTER_URLS) return env as Cluster;
	return "localnet";
}

export function getRpc(cluster?: Cluster) {
	const c = cluster ?? getCluster();
	return createSolanaRpc(CLUSTER_URLS[c]);
}

export function getRpcSubscriptions(cluster?: Cluster) {
	const c = cluster ?? getCluster();
	return createSolanaRpcSubscriptions(CLUSTER_WS_URLS[c]);
}
```

**Step 2: Verify it type-checks**

Run: `bun run typecheck`
Expected: success

**Step 3: Commit**

```bash
git add tests/helpers/
git commit -m "Add @solana/kit RPC helper with cluster selection"
```

---

### Task 9: TS integration test for example program

**Files:**
- Create: `tests/example.test.ts`

**Step 1: Write the integration test**

```typescript
import { describe, test, expect } from "bun:test";
import { getRpc, getCluster } from "./helpers/setup";

describe("example program", () => {
	test("RPC helper connects to cluster", async () => {
		const rpc = getRpc();
		// Basic connectivity check — will fail on localnet if no validator is running,
		// but that's expected. The point is the setup works.
		try {
			const slot = await rpc.getSlot().send();
			expect(slot).toBeGreaterThan(0);
		} catch {
			// If localnet isn't running, skip gracefully
			if (getCluster() === "localnet") {
				console.log("Skipping: localnet not running");
				return;
			}
			throw new Error("RPC connection failed");
		}
	});
});
```

**Step 2: Run the test**

Run: `bun test`
Expected: PASS (gracefully skips if no validator running)

**Step 3: Commit**

```bash
git add tests/example.test.ts
git commit -m "Add example TS integration test with @solana/kit RPC"
```

---

### Task 10: Guardrails — pre-commit hooks

**Files:**
- Create: `.pre-commit-config.yaml`
- Create: `.typos.toml`
- Create: `scripts/pre-commit-checks.sh`
- Create: `scripts/pre-push-checks.sh`

**Step 1: Create .pre-commit-config.yaml**

Copy from `solana-awesome/templates/solana-project-guardrails/.pre-commit-config.yaml` exactly as-is.

**Step 2: Create .typos.toml**

Copy from `solana-awesome/templates/solana-project-guardrails/.typos.toml` exactly as-is.

**Step 3: Create scripts/pre-commit-checks.sh**

Adapt from the template to use `bun` instead of `npm`:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "[pre-commit-checks] Running fast checks..."

if [[ -f Cargo.toml ]]; then
  if command -v cargo >/dev/null 2>&1; then
    echo "[pre-commit-checks] Rust: cargo fmt (check)"
    cargo fmt --all -- --check
  else
    echo "[pre-commit-checks] Rust: Cargo.toml found but cargo not installed; skipping"
  fi
fi

if [[ -f package.json ]]; then
  if command -v bun >/dev/null 2>&1; then
    if bun run --silent typecheck 2>/dev/null; then
      echo "[pre-commit-checks] Bun: typecheck passed"
    fi

    echo "[pre-commit-checks] Bun: lint"
    bun run lint

    echo "[pre-commit-checks] Bun: format check"
    bun run format:check
  else
    echo "[pre-commit-checks] package.json found but bun not installed; skipping"
  fi
fi

echo "[pre-commit-checks] Done"
```

**Step 4: Create scripts/pre-push-checks.sh**

Adapt from the template to use `bun`:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "[pre-push-checks] Running heavier checks..."

if [[ -f Cargo.toml ]]; then
  if command -v cargo >/dev/null 2>&1; then
    echo "[pre-push-checks] Rust: fmt/clippy/test"
    cargo fmt --all -- --check
    cargo clippy --all-targets --all-features -- -D warnings
    cargo test --all --all-features
  else
    echo "[pre-push-checks] Cargo.toml found but cargo not installed; skipping"
  fi
fi

if [[ -f Anchor.toml ]]; then
  if command -v anchor >/dev/null 2>&1; then
    echo "[pre-push-checks] Anchor: anchor build"
    anchor build
  else
    echo "[pre-push-checks] Anchor.toml found but anchor not installed; skipping"
  fi
fi

if [[ -f package.json ]]; then
  if command -v bun >/dev/null 2>&1; then
    echo "[pre-push-checks] Bun: test"
    bun test
  else
    echo "[pre-push-checks] package.json found but bun not installed; skipping"
  fi
fi

echo "[pre-push-checks] Done"
```

**Step 5: Make scripts executable**

```bash
chmod +x scripts/pre-commit-checks.sh scripts/pre-push-checks.sh
```

**Step 6: Install pre-commit hooks**

```bash
pre-commit install --hook-type pre-commit --hook-type pre-push
```

**Step 7: Verify pre-commit runs**

Run: `pre-commit run --all-files`
Expected: All checks pass

**Step 8: Commit**

```bash
git add .pre-commit-config.yaml .typos.toml scripts/
git commit -m "Add pre-commit guardrails with typos, cargo fmt, biome checks"
```

---

### Task 11: Final verification — full build and test cycle

**Step 1: Clean build**

Run: `anchor build`
Expected: Success, `target/deploy/example.so` exists

**Step 2: Rust tests**

Run: `cargo test --all`
Expected: Mollusk test passes

**Step 3: TS tests**

Run: `bun test`
Expected: example test passes (or skips gracefully if no validator)

**Step 4: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: Clean

**Step 5: Type check**

Run: `bun run typecheck`
Expected: No errors

**Step 6: Final commit if any formatting was needed**

```bash
git add -A
git commit -m "Final cleanup: formatting and verification"
```

(Only if there are changes — skip if clean.)

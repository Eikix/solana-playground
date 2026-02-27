# Adding a New Project

Follow this checklist when adding a new program, script, or library to the repo.

## Checklist

### 1. Create the project

- **Program:** Add to `programs/<name>/`, include in `Cargo.toml` workspace members, and register the program ID in `Anchor.toml` under `[programs.localnet]`.
- **Script:** Add to `scripts/<name>.ts`. If it needs a `package.json` shortcut, add one under `"scripts"`.
- **Library crate:** Add to `lib/<name>/`, include in `Cargo.toml` workspace members.

### 2. Write a README for the project

Every program directory should have a short `README.md` explaining:

- What the program does
- Key instructions / entry points
- How to test it
- Any non-obvious design decisions

Scripts and library crates benefit from inline doc-comments at minimum; a README is encouraged for anything non-trivial.

### 3. Update the root README

- Add the program, script, or library to the relevant table in the root [README.md](README.md) (Programs, Scripts & Tools, or Shared Libraries).
- If the project introduces new commands, add them to the Commands table.

### 4. Add tests

- **Rust programs:** Add Mollusk SVM unit tests in `programs/<name>/tests/mollusk_test.rs`.
- **TypeScript:** Add integration tests in `tests/<name>.test.ts`. Use `tests/helpers/setup.ts` for RPC helpers.
- Make sure tests pass: `cargo test -p <name>` and/or `bun test`.

### 5. Verify quality gates pass

Before pushing, confirm the full suite is green:

```bash
cargo fmt --check
cargo clippy --all-targets
cargo test --all
anchor build
bun run typecheck
bun run lint
bun test
```

Or simply push and let the pre-push hook run everything for you.

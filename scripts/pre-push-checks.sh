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

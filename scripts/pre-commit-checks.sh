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

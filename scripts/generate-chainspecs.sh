#!/usr/bin/env bash
set -euo pipefail

# Generate raw chain specs for integration tests using zombienet.
#
# Spawns zombienet networks to produce complete raw chain specs with parachain
# genesis data baked into the relay spec. These cached specs eliminate the
# expensive WASM execution + raw conversion that zombienet does at spawn time
# (~3-5 min per chain).
#
# Usage:
#   ./scripts/generate-chainspecs.sh
#
# Environment variables:
#   CHAIN_SPECS_DIR   - Output directory (default: ./chain-specs)
#   BIN_DIR           - Directory containing polkadot/polkadot-parachain binaries (default: ./bin)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

CHAIN_SPECS_DIR="${CHAIN_SPECS_DIR:-${PROJECT_DIR}/chain-specs}"
BIN_DIR="${BIN_DIR:-${PROJECT_DIR}/bin}"

echo "Chain Spec Generator (zombienet-based)"
echo "  Output:   ${CHAIN_SPECS_DIR}"
echo "  Binaries: ${BIN_DIR}"
echo ""

# Verify prerequisites
if [ ! -x "${BIN_DIR}/polkadot" ]; then
  echo "Error: polkadot not found at ${BIN_DIR}/polkadot" >&2
  echo "Run ./scripts/download-binaries.sh first." >&2
  exit 1
fi
if [ ! -x "${BIN_DIR}/polkadot-parachain" ]; then
  echo "Error: polkadot-parachain not found at ${BIN_DIR}/polkadot-parachain" >&2
  exit 1
fi

mkdir -p "${CHAIN_SPECS_DIR}"

echo "Running zombienet chain spec generator..."
cd "${PROJECT_DIR}/integration-tests"
POLKADOT_BINARY_PATH="${BIN_DIR}/polkadot" \
  POLKADOT_PARACHAIN_BINARY_PATH="${BIN_DIR}/polkadot-parachain" \
  CHAIN_SPECS_DIR="${CHAIN_SPECS_DIR}" \
  RUST_LOG=info \
  cargo test --test generate_chain_specs -- --nocapture

echo ""
echo "Chain specs generated:"
ls -lh "${CHAIN_SPECS_DIR}"/*.json 2>/dev/null || echo "  (none found)"

#!/usr/bin/env bash
set -euo pipefail

# Build Polkadot Fellows runtimes with the fast-runtime feature flag.
#
# This clones polkadot-fellows/runtimes at a pinned tag and builds the WASM
# runtime blobs with fast-runtime enabled. Fast-runtime reduces session lengths
# from 4 hours to ~60 seconds, which is essential for integration tests where
# parachains need a session change before they start producing blocks.
#
# Usage:
#   ./integration-tests/scripts/build-fast-runtimes.sh
#
# Environment variables:
#   FELLOWS_VERSION   - Git tag to build (default: v2.0.7)
#   RUNTIMES_DIR      - Output directory for WASM files (default: ./integration-tests/runtimes/fast)
#   CACHE_DIR         - Clone/build cache directory (default: ./.cache/fellows-runtimes)

FELLOWS_VERSION="${FELLOWS_VERSION:-v2.0.7}"
RUNTIMES_DIR="${RUNTIMES_DIR:-$(pwd)/integration-tests/runtimes/fast}"
CACHE_DIR="${CACHE_DIR:-$(pwd)/.cache/fellows-runtimes}"
REPO_URL="https://github.com/polkadot-fellows/runtimes.git"

# Expected output WASM filenames (after substrate-wasm-builder).
RELAY_WASM="polkadot_runtime.compact.compressed.wasm"
ASSET_HUB_WASM="asset_hub_polkadot_runtime.compact.compressed.wasm"
COLLECTIVES_WASM="collectives_polkadot_runtime.compact.compressed.wasm"
KUSAMA_RELAY_WASM="staging_kusama_runtime.compact.compressed.wasm"
KUSAMA_ASSET_HUB_WASM="asset_hub_kusama_runtime.compact.compressed.wasm"

check_prerequisites() {
  echo "Checking prerequisites..."

  if ! command -v cargo >/dev/null 2>&1; then
    echo "Error: cargo not found. Install Rust: https://rustup.rs" >&2
    exit 1
  fi

  if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
    echo "Adding wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
  fi

  echo "  Rust: $(rustc --version)"
  echo "  Cargo: $(cargo --version)"
  echo ""
}

clone_or_update() {
  local repo_dir="${CACHE_DIR}/${FELLOWS_VERSION}"

  if [ -d "${repo_dir}/.git" ]; then
    echo "Using cached clone at ${repo_dir}"
    cd "${repo_dir}"
    # Verify we're at the right tag
    local current_tag
    current_tag="$(git describe --tags --exact-match 2>/dev/null || echo 'none')"
    if [ "${current_tag}" != "${FELLOWS_VERSION}" ]; then
      echo "  Checking out tag ${FELLOWS_VERSION}..."
      git fetch --tags
      git checkout "${FELLOWS_VERSION}"
    fi
  else
    echo "Cloning ${REPO_URL} at tag ${FELLOWS_VERSION}..."
    mkdir -p "${CACHE_DIR}"
    git clone --depth 1 --branch "${FELLOWS_VERSION}" "${REPO_URL}" "${repo_dir}"
    cd "${repo_dir}"
  fi

  echo "  At commit: $(git rev-parse --short HEAD)"
  echo ""
}

build_runtimes() {
  echo "Building runtimes with fast-runtime feature..."
  echo "  This may take 10-30 minutes on first build."
  echo ""

  # Polkadot relay runtime (has fast-runtime feature)
  echo "[1/5] Building polkadot-runtime (fast-runtime)..."
  cargo build --release -p polkadot-runtime --features fast-runtime
  echo "  Done."

  # Asset Hub Polkadot runtime (has fast-runtime feature)
  echo "[2/5] Building asset-hub-polkadot-runtime (fast-runtime)..."
  cargo build --release -p asset-hub-polkadot-runtime --features fast-runtime
  echo "  Done."

  # Collectives Polkadot runtime (no fast-runtime feature at v2.0.7)
  echo "[3/5] Building collectives-polkadot-runtime (standard)..."
  cargo build --release -p collectives-polkadot-runtime
  echo "  Done."

  # Kusama relay runtime (has fast-runtime feature; fellowship lives on relay)
  echo "[4/5] Building staging-kusama-runtime (fast-runtime)..."
  cargo build --release -p staging-kusama-runtime --features fast-runtime
  echo "  Done."

  # Asset Hub Kusama runtime (no fast-runtime feature at v2.0.7)
  echo "[5/5] Building asset-hub-kusama-runtime (standard)..."
  cargo build --release -p asset-hub-kusama-runtime
  echo "  Done."
  echo ""
}

copy_wasm_files() {
  local wbuild_dir="target/release/wbuild"

  echo "Copying WASM files to ${RUNTIMES_DIR}..."
  mkdir -p "${RUNTIMES_DIR}"

  local relay_src="${wbuild_dir}/polkadot-runtime/${RELAY_WASM}"
  local ah_src="${wbuild_dir}/asset-hub-polkadot-runtime/${ASSET_HUB_WASM}"
  local coll_src="${wbuild_dir}/collectives-polkadot-runtime/${COLLECTIVES_WASM}"
  local kusama_relay_src="${wbuild_dir}/staging-kusama-runtime/${KUSAMA_RELAY_WASM}"
  local kusama_ah_src="${wbuild_dir}/asset-hub-kusama-runtime/${KUSAMA_ASSET_HUB_WASM}"

  for src in "${relay_src}" "${ah_src}" "${coll_src}" "${kusama_relay_src}" "${kusama_ah_src}"; do
    if [ ! -f "${src}" ]; then
      echo "Error: Expected WASM not found: ${src}" >&2
      echo "  Build may have failed. Check cargo output above." >&2
      exit 1
    fi
  done

  cp "${relay_src}" "${RUNTIMES_DIR}/${RELAY_WASM}"
  cp "${ah_src}" "${RUNTIMES_DIR}/${ASSET_HUB_WASM}"
  cp "${coll_src}" "${RUNTIMES_DIR}/${COLLECTIVES_WASM}"
  cp "${kusama_relay_src}" "${RUNTIMES_DIR}/${KUSAMA_RELAY_WASM}"
  cp "${kusama_ah_src}" "${RUNTIMES_DIR}/${KUSAMA_ASSET_HUB_WASM}"

  echo "  ${RELAY_WASM} ($(wc -c < "${RUNTIMES_DIR}/${RELAY_WASM}" | tr -d ' ') bytes)"
  echo "  ${ASSET_HUB_WASM} ($(wc -c < "${RUNTIMES_DIR}/${ASSET_HUB_WASM}" | tr -d ' ') bytes)"
  echo "  ${COLLECTIVES_WASM} ($(wc -c < "${RUNTIMES_DIR}/${COLLECTIVES_WASM}" | tr -d ' ') bytes)"
  echo "  ${KUSAMA_RELAY_WASM} ($(wc -c < "${RUNTIMES_DIR}/${KUSAMA_RELAY_WASM}" | tr -d ' ') bytes)"
  echo "  ${KUSAMA_ASSET_HUB_WASM} ($(wc -c < "${RUNTIMES_DIR}/${KUSAMA_ASSET_HUB_WASM}" | tr -d ' ') bytes)"
  echo ""
}

main() {
  echo "Fellows Runtime Builder (fast-runtime)"
  echo "  Version: ${FELLOWS_VERSION}"
  echo "  Output:  ${RUNTIMES_DIR}"
  echo "  Cache:   ${CACHE_DIR}"
  echo ""

  # Check if WASMs already exist
  if [ -f "${RUNTIMES_DIR}/${RELAY_WASM}" ] && \
     [ -f "${RUNTIMES_DIR}/${ASSET_HUB_WASM}" ] && \
     [ -f "${RUNTIMES_DIR}/${COLLECTIVES_WASM}" ] && \
     [ -f "${RUNTIMES_DIR}/${KUSAMA_RELAY_WASM}" ] && \
     [ -f "${RUNTIMES_DIR}/${KUSAMA_ASSET_HUB_WASM}" ]; then
    echo "All WASM files already exist in ${RUNTIMES_DIR}."
    echo "  Delete them to force a rebuild."
    echo ""
    ls -lh "${RUNTIMES_DIR}"/*.wasm
    exit 0
  fi

  check_prerequisites
  clone_or_update
  build_runtimes
  copy_wasm_files

  echo "All runtimes built successfully!"
  echo "  Polkadot Relay:       ${RUNTIMES_DIR}/${RELAY_WASM}"
  echo "  Polkadot Asset Hub:   ${RUNTIMES_DIR}/${ASSET_HUB_WASM}"
  echo "  Polkadot Collectives: ${RUNTIMES_DIR}/${COLLECTIVES_WASM}"
  echo "  Kusama Relay:         ${RUNTIMES_DIR}/${KUSAMA_RELAY_WASM}"
  echo "  Kusama Asset Hub:     ${RUNTIMES_DIR}/${KUSAMA_ASSET_HUB_WASM}"
}

main "$@"

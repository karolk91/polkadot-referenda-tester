#!/usr/bin/env bash
set -euo pipefail

# Update runtimes, binaries, and chain specs for a new Fellows release.
#
# Orchestrates the full pipeline:
#   1. Build fast-runtime WASMs from Fellows repo
#   2. Download Polkadot SDK binaries (if --sdk is specified)
#   3. Regenerate raw chain specs via zombienet
#
# Usage:
#   ./scripts/update-runtimes.sh                                          # rebuild current defaults
#   ./scripts/update-runtimes.sh --fellows v2.1.0                         # new fellows version
#   ./scripts/update-runtimes.sh --fellows v2.1.0 --sdk polkadot-stable2601  # both

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FELLOWS_VERSION=""
SDK_VERSION=""

usage() {
  echo "Usage: $0 [--fellows VERSION] [--sdk VERSION]"
  echo ""
  echo "Options:"
  echo "  --fellows VERSION   Fellows repo tag (e.g., v2.1.0)"
  echo "  --sdk VERSION       Polkadot SDK release tag (e.g., polkadot-stable2601)"
  echo ""
  echo "Examples:"
  echo "  $0                                           # rebuild with current defaults"
  echo "  $0 --fellows v2.1.0                          # new fellows version"
  echo "  $0 --fellows v2.1.0 --sdk polkadot-stable2601  # both"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fellows)
      FELLOWS_VERSION="$2"
      shift 2
      ;;
    --sdk)
      SDK_VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      ;;
  esac
done

echo "=== Runtime & Chain Spec Updater ==="
echo ""
echo "  Project:  ${PROJECT_DIR}"
[ -n "${FELLOWS_VERSION}" ] && echo "  Fellows:  ${FELLOWS_VERSION}" || echo "  Fellows:  (current default)"
[ -n "${SDK_VERSION}" ] && echo "  SDK:      ${SDK_VERSION}" || echo "  SDK:      (no change)"
echo ""

# --- Step 1: Build fast-runtime WASMs ---
echo "=== Step 1/3: Build fast-runtime WASMs ==="
echo ""

RUNTIMES_DIR="${PROJECT_DIR}/runtimes/fast"

# Delete existing WASMs to force rebuild
if ls "${RUNTIMES_DIR}"/*.wasm >/dev/null 2>&1; then
  echo "Removing existing WASMs to force rebuild..."
  rm -f "${RUNTIMES_DIR}"/*.wasm
fi

cd "${PROJECT_DIR}"
export_args=()
[ -n "${FELLOWS_VERSION}" ] && export_args+=(FELLOWS_VERSION="${FELLOWS_VERSION}")

env "${export_args[@]}" "${SCRIPT_DIR}/build-fast-runtimes.sh"
echo ""

# --- Step 2: Download SDK binaries (only if --sdk specified) ---
echo "=== Step 2/3: Download Polkadot SDK binaries ==="
echo ""

if [ -n "${SDK_VERSION}" ]; then
  BIN_DIR="${PROJECT_DIR}/bin"

  # Delete existing binaries to force re-download
  if [ -d "${BIN_DIR}" ]; then
    echo "Removing existing binaries for SDK version change..."
    rm -rf "${BIN_DIR}"
  fi

  cd "${PROJECT_DIR}"
  POLKADOT_SDK_VERSION="${SDK_VERSION}" BIN_DIR="${BIN_DIR}" "${SCRIPT_DIR}/download-binaries.sh"
else
  echo "No --sdk specified, skipping binary download."
  echo "Using existing binaries in ${PROJECT_DIR}/bin/"
fi
echo ""

# --- Step 3: Regenerate chain specs ---
echo "=== Step 3/3: Regenerate chain specs ==="
echo ""

CHAIN_SPECS_DIR="${PROJECT_DIR}/chain-specs"

# Delete existing chain specs to force regeneration
if ls "${CHAIN_SPECS_DIR}"/*.json >/dev/null 2>&1; then
  echo "Removing existing chain specs..."
  rm -f "${CHAIN_SPECS_DIR}"/*.json
fi

cd "${PROJECT_DIR}"
CHAIN_SPECS_DIR="${CHAIN_SPECS_DIR}" BIN_DIR="${PROJECT_DIR}/bin" "${SCRIPT_DIR}/generate-chainspecs.sh"
echo ""

# --- Summary ---
echo "=== Update Complete ==="
echo ""
echo "WASMs:"
ls -lh "${RUNTIMES_DIR}"/*.wasm 2>/dev/null | awk '{print "  " $NF " (" $5 ")"}'
echo ""
echo "Chain specs:"
ls -lh "${CHAIN_SPECS_DIR}"/*.json 2>/dev/null | awk '{print "  " $NF " (" $5 ")"}'
echo ""
echo "Next steps:"
echo "  1. Review the changes: git diff --stat"
echo "  2. Run integration tests locally to verify"
echo "  3. Commit the updated files"

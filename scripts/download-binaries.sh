#!/usr/bin/env bash
set -euo pipefail

# Download Polkadot SDK binaries for integration tests.
# Works on Linux x86_64 and macOS ARM64 (aarch64).
#
# Usage:
#   ./scripts/download-binaries.sh
#
# Environment variables:
#   POLKADOT_SDK_VERSION  - Release tag (default: polkadot-stable2512)
#   BIN_DIR               - Download directory (default: ./bin)

POLKADOT_SDK_VERSION="${POLKADOT_SDK_VERSION:-polkadot-stable2512}"
BIN_DIR="${BIN_DIR:-$(pwd)/bin}"
BASE_URL="https://github.com/paritytech/polkadot-sdk/releases/download/${POLKADOT_SDK_VERSION}"

BINARIES=(
  polkadot
  polkadot-prepare-worker
  polkadot-execute-worker
  polkadot-parachain
  chain-spec-builder
)

detect_platform() {
  local os arch suffix
  os="$(uname -s)"
  arch="$(uname -m)"

  case "${os}" in
    Linux)
      if [ "${arch}" != "x86_64" ]; then
        echo "Error: Only x86_64 Linux is supported, got ${arch}" >&2
        exit 1
      fi
      suffix=""
      ;;
    Darwin)
      if [ "${arch}" != "arm64" ] && [ "${arch}" != "aarch64" ]; then
        echo "Error: Only ARM64 macOS is supported, got ${arch}" >&2
        exit 1
      fi
      suffix="-aarch64-apple-darwin"
      ;;
    *)
      echo "Error: Unsupported OS: ${os}" >&2
      exit 1
      ;;
  esac

  echo "${suffix}"
}

download_binary() {
  local name="$1" suffix="$2"
  local remote_name="${name}${suffix}"
  local local_path="${BIN_DIR}/${name}"
  local url="${BASE_URL}/${remote_name}"
  local sha_url="${url}.sha256"

  if [ -f "${local_path}" ]; then
    echo "  [skip] ${name} already exists"
    return 0
  fi

  echo "  [download] ${name} from ${url}"
  curl -fSL --retry 3 --retry-delay 5 -o "${local_path}" "${url}"
  chmod +x "${local_path}"

  # Download and verify SHA256 checksum
  local sha_file
  sha_file="$(mktemp)"
  if curl -fSL --retry 2 -o "${sha_file}" "${sha_url}" 2>/dev/null; then
    local expected actual
    expected="$(awk '{print $1}' "${sha_file}")"
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "${local_path}" | awk '{print $1}')"
    else
      actual="$(shasum -a 256 "${local_path}" | awk '{print $1}')"
    fi
    if [ "${expected}" = "${actual}" ]; then
      echo "  [ok] SHA256 verified: ${actual}"
    else
      echo "  [WARN] SHA256 mismatch for ${name}!" >&2
      echo "    expected: ${expected}" >&2
      echo "    actual:   ${actual}" >&2
      rm -f "${local_path}"
      rm -f "${sha_file}"
      return 1
    fi
  else
    echo "  [info] No SHA256 file available, skipping checksum verification"
  fi
  rm -f "${sha_file}"
}

verify_binary() {
  local name="$1"
  local local_path="${BIN_DIR}/${name}"

  if ! "${local_path}" --version >/dev/null 2>&1; then
    echo "  [FAIL] ${name} --version failed" >&2
    return 1
  fi
  local version
  version="$("${local_path}" --version 2>&1 | head -1)"
  echo "  [ok] ${name}: ${version}"
}

main() {
  echo "Polkadot SDK Binary Downloader"
  echo "  Version: ${POLKADOT_SDK_VERSION}"
  echo "  Target:  ${BIN_DIR}"
  echo ""

  local suffix
  suffix="$(detect_platform)"
  echo "Platform suffix: '${suffix:-(linux x86_64)}'"
  echo ""

  mkdir -p "${BIN_DIR}"

  echo "Downloading binaries..."
  for bin in "${BINARIES[@]}"; do
    download_binary "${bin}" "${suffix}"
  done
  echo ""

  echo "Verifying binaries..."
  for bin in "${BINARIES[@]}"; do
    verify_binary "${bin}"
  done
  echo ""

  echo "All binaries ready in ${BIN_DIR}"
}

main "$@"

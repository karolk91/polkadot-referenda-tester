# Integration Tests

Rust integration tests using [zombienet-sdk](https://github.com/paritytech/zombienet-sdk) to spawn real Polkadot/Kusama test networks and run the CLI tool against them.

## Prerequisites

- Rust toolchain (stable + nightly for formatting)
- Node.js + Yarn (for the TypeScript CLI)
- ~20 GB disk space (binaries, runtimes, chain specs, build cache)

## Setup (step by step)

All commands run from the **project root**.

### 1. Build the TypeScript CLI

```bash
yarn install
yarn build
```

### 2. Download Polkadot SDK binaries

Downloads `polkadot`, `polkadot-parachain`, `chain-spec-builder` and workers to `bin/`.

```bash
./integration-tests/scripts/download-binaries.sh
```

Defaults to `polkadot-stable2512`. Override with `POLKADOT_SDK_VERSION=polkadot-stable2601`.

### 3. Build fast-runtime WASMs

Clones [polkadot-fellows/runtimes](https://github.com/polkadot-fellows/runtimes) and builds WASMs with `--features fast-runtime` (reduces session length from 4h to ~60s). Output goes to `integration-tests/runtimes/fast/`.

```bash
./integration-tests/scripts/build-fast-runtimes.sh
```

Defaults to `v2.0.7`. Override with `FELLOWS_VERSION=v2.1.0`. First build takes ~30 min.

### 4. Generate raw chain specs

Spawns temporary zombienet networks to produce raw chain specs in `integration-tests/chain-specs/`. These are optional but skip ~3-5 min of WASM execution per test run.

```bash
cd integration-tests
POLKADOT_BINARY_PATH=../bin/polkadot \
POLKADOT_PARACHAIN_BINARY_PATH=../bin/polkadot-parachain \
cargo test --test generate_chain_specs -- --nocapture
```

### All-in-one update

When a new fellows release comes out, run the convenience script to rebuild everything:

```bash
./integration-tests/scripts/update-runtimes.sh                     # current defaults
./integration-tests/scripts/update-runtimes.sh --fellows v2.1.0    # new fellows version
```

## Running Tests

```bash
cd integration-tests

# Run all test suites (~45 min total)
POLKADOT_BINARY_PATH=../bin/polkadot \
POLKADOT_PARACHAIN_BINARY_PATH=../bin/polkadot-parachain \
TOOL_PROJECT_DIR=$(cd .. && pwd) \
RUST_LOG=info cargo test -- --nocapture

# Run a specific test suite
POLKADOT_BINARY_PATH=../bin/polkadot \
POLKADOT_PARACHAIN_BINARY_PATH=../bin/polkadot-parachain \
TOOL_PROJECT_DIR=$(cd .. && pwd) \
RUST_LOG=info cargo test polkadot_governance_all_tracks -- --nocapture
```

### Test Suites

| Suite | Duration | What it tests |
|-------|----------|---------------|
| `polkadot_governance_all_tracks` | ~10 min | 16 governance tracks on Polkadot Asset Hub |
| `polkadot_fellowship_tracks_part1` | ~9 min | Fellowship tracks 1-15 on Polkadot Collectives |
| `polkadot_fellowship_tracks_part2` | ~9 min | Fellowship tracks 21-33 + multi-chain scenarios |
| `kusama_governance_all_tracks` | ~10 min | 16 governance tracks on Kusama Asset Hub |
| `kusama_fellowship_all_tracks` | ~10 min | 10 fellowship tracks on Kusama relay |
| `validation_test_suite` | ~10 sec | CLI argument validation (no network required) |

## Linting & Formatting

```bash
cd integration-tests

# Lint
cargo clippy --tests -- -D warnings

# Format
cargo +nightly fmt
```

## Project Structure

```
integration-tests/
  tests/
    tests.rs                 # Main test entry (imports all_tracks + scenarios)
    all_tracks.rs            # Per-track governance & fellowship tests
    scenarios.rs             # CLI validation & edge-case tests
    generate_chain_specs.rs  # Chain spec generation utility
    common/                  # Shared test infrastructure
      config.rs              # Zombienet network configurations
      context.rs             # Test context structs (fork blocks, subxt clients)
      call_data.rs           # Subxt-based call data generation
      network.rs             # Network spawn helpers
      tool_runner.rs         # CLI invocation wrapper
      tracks.rs              # Track definitions
  runtimes/fast/             # Fast-runtime WASMs
  chain-specs/               # Cached raw chain specs
  scripts/                   # Build & setup scripts
```

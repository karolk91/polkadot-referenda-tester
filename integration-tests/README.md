# Integration Tests

Rust integration tests using [zombienet-sdk](https://github.com/paritytech/zombienet-sdk) to spawn real Polkadot/Kusama test networks and run the CLI tool against them.

## Prerequisites

- Rust toolchain (stable + nightly for formatting)
- Node.js 22.12+ with npm (for the TypeScript CLI)
- ~20 GB disk space (binaries, runtimes, chain specs, build cache)

## Setup (step by step)

All commands run from the **project root**.

### 1. Build the TypeScript CLI

```bash
npm ci
npm run build
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

Defaults to `v2.3.2`. Override with `FELLOWS_VERSION=v2.4.0`. First build takes ~30 min.

### 4. Generate raw chain specs

Spawns temporary zombienet networks to produce raw chain specs in `integration-tests/chain-specs/`. These are optional but skip ~3-5 min of WASM execution per test run. The tests use the cached specs only when every spec of a network is present. Delete the old specs first: the generator stops when cached specs exist.

```bash
cd integration-tests
POLKADOT_BINARY_PATH=../bin/polkadot \
POLKADOT_PARACHAIN_BINARY_PATH=../bin/polkadot-parachain \
cargo run --bin generate_chain_specs
```

The raw storage overrides (`src/genesis.rs`) must match the keys in the cached specs. Check them with:

```bash
cargo run --bin bake_raw_overrides -- --check
```

Without `--check` the tool writes out-of-sync keys into the relay specs. An out-of-sync parachain spec needs regenerated specs, because the cached relay spec registers the parachain genesis heads.

### All-in-one update

When a new fellows release comes out, run the convenience script to rebuild everything:

```bash
./integration-tests/scripts/update-runtimes.sh                     # current defaults
./integration-tests/scripts/update-runtimes.sh --fellows v2.1.0    # new fellows version
```

## Running Tests

```bash
cd integration-tests

# Run all test suites, one after another (~2.5 h total)
POLKADOT_BINARY_PATH=../bin/polkadot \
POLKADOT_PARACHAIN_BINARY_PATH=../bin/polkadot-parachain \
TOOL_PROJECT_DIR=$(cd .. && pwd) \
RUST_LOG=info cargo test --test tests -- --nocapture --test-threads=1

# Run a specific test suite
POLKADOT_BINARY_PATH=../bin/polkadot \
POLKADOT_PARACHAIN_BINARY_PATH=../bin/polkadot-parachain \
TOOL_PROJECT_DIR=$(cd .. && pwd) \
RUST_LOG=info cargo test polkadot_governance_all_tracks -- --nocapture
```

### Test Suites

| Suite | Duration | What it tests |
|-------|----------|---------------|
| `polkadot_governance_all_tracks` | ~30 min | 16 governance tracks on Polkadot Asset Hub + scenarios, incl. `--then` steps with a post-test |
| `polkadot_fellowship_tracks_part1` | ~25 min | The first 15 fellowship tracks on Polkadot Collectives (Members through RetainAt6Dan) |
| `polkadot_fellowship_tracks_part2` | ~20 min | The other 9 fellowship tracks + 9 multi-chain scenarios |
| `kusama_governance_all_tracks` | ~30 min | 16 governance tracks on Kusama Asset Hub + scenarios |
| `kusama_fellowship_all_tracks` | ~15 min | 10 fellowship tracks on the Kusama relay + scenarios |
| `polkadot_governance_approved_future_enactment` | ~4 min | An approved referendum with a future enactment, from a chopsticks `import-storage` config |
| `bridged_fellowship_by_id` | ~8 min | Polkadot fellowship → Kusama governance over a local bridge (two zombienets) |
| `validation_test_suite` | ~10 sec | CLI argument validation (no network required) |

## Linting & Formatting

```bash
cd integration-tests

# Lint
cargo clippy --all-targets -- -D warnings

# Format
cargo +nightly fmt
```

## Project Structure

```
integration-tests/
  src/                       # library `harness`
    binaries.rs              # node binaries, network spawn
    chains.rs                # chain table: names, para IDs, runtimes, nodes, overrides
    genesis.rs               # genesis overrides and raw storage entries
    network_config.rs        # zombienet network config from the chain table
    context.rs               # chain endpoints and fork points of a spawned network
    calls.rs                 # referendum call data and submission
    hrmp.rs                  # HRMP channels for the bridged test
    tool_runner.rs           # CLI invocation and output checks
    tracks.rs                # track tables
    bin/
      generate_chain_specs.rs
      bake_raw_overrides.rs
  tests/
    tests.rs                 # test binary: all suites below
    all_tracks.rs            # per-track and scenario suites
    approved_future_enactment.rs
    bridged.rs
    scenarios.rs             # CLI validation
  runtimes/fast/             # Fast-runtime WASMs
  chain-specs/               # Cached raw chain specs
  scripts/                   # Build & setup scripts
```

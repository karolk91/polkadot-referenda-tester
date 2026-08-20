# Polkadot Referenda Tester

CLI for dry-running Polkadot/Kusama referenda against local Chopsticks forks.

## Usage

Run directly from GitHub without installing:

```bash
# Single-chain execution
npx github:karolk91/polkadot-referenda-tester test \
  --governance-chain-url wss://asset-hub-polkadot-rpc.n.dwellir.com \
  --referendum 1777

# With fellowship companion
npx github:karolk91/polkadot-referenda-tester test \
  --governance-chain-url wss://asset-hub-polkadot-rpc.n.dwellir.com \
  --fellowship-chain-url wss://polkadot-collectives-rpc.polkadot.io \
  --referendum 1777 \
  --fellowship 425

# With fellowship companion using state at specific blocks
npx github:karolk91/polkadot-referenda-tester test \
  --governance-chain-url wss://asset-hub-polkadot-rpc.n.dwellir.com \
  --fellowship-chain-url wss://polkadot-collectives-rpc.polkadot.io \
  --referendum 1777 \
  --fellowship 425

# List fellowship ongoing referendas at specific block
npx github:karolk91/polkadot-referenda-tester list \
  --fellowship-chain-url wss://polkadot-collectives-rpc.polkadot.io,7473112 \
  --status ongoing

# Test some fellowship ref alone
npx github:karolk91/polkadot-referenda-tester test \
  --fellowship-chain-url wss://polkadot-collectives-rpc.polkadot.io \
  --fellowship 425

# Create and test a governance referendum from call data
npx github:karolk91/polkadot-referenda-tester test \
  --governance-chain-url wss://asset-hub-polkadot-rpc.n.dwellir.com \
  --call-to-create-governance-referendum 0x1503...

# Create and test a governance referendum with a preimage
npx github:karolk91/polkadot-referenda-tester test \
  --governance-chain-url wss://asset-hub-polkadot-rpc.n.dwellir.com \
  --call-to-note-preimage-for-governance-referendum 0x1e00... \
  --call-to-create-governance-referendum 0x1503...

# Create and test a fellowship referendum from call data
npx github:karolk91/polkadot-referenda-tester test \
  --fellowship-chain-url wss://polkadot-collectives-rpc.polkadot.io \
  --call-to-create-fellowship-referendum 0x1703...

# Create and test a fellowship referendum with a preimage
npx github:karolk91/polkadot-referenda-tester test \
  --fellowship-chain-url wss://polkadot-collectives-rpc.polkadot.io \
  --call-to-note-preimage-for-fellowship-referendum 0x1e00... \
  --call-to-create-fellowship-referendum 0x1703...

# Create both governance and fellowship referenda from call data
npx github:karolk91/polkadot-referenda-tester test \
  --governance-chain-url wss://asset-hub-polkadot-rpc.n.dwellir.com \
  --fellowship-chain-url wss://polkadot-collectives-rpc.polkadot.io \
  --call-to-create-governance-referendum 0x1503... \
  --call-to-create-fellowship-referendum 0x1703...
```

## Bridged referenda (Polkadot Fellowship → Kusama governance)

When `--fellowship-chain-url` points at a Polkadot chain (Collectives) and `--governance-chain-url` points at a Kusama chain (Kusama Asset Hub), the tool auto-detects the bridged scenario and:

1. Forks five chains locally: Polkadot Collectives, Polkadot Asset Hub, Polkadot Bridge Hub, Kusama Asset Hub and Kusama Bridge Hub.
2. Runs the fellowship referendum on Polkadot Collectives, which sends the `whitelist_call` towards Kusama Asset Hub over the Polkadot↔Kusama bridge.
3. Drives the bridge (both Bridge Hubs) until the message is delivered and `CallWhitelisted` is emitted on Kusama Asset Hub.
4. If `--call-to-create-governance-referendum` is also supplied, runs the Kusama Asset Hub WhitelistedCaller referendum so the whitelisted call actually dispatches.

```bash
yarn cli test \
  --fellowship-chain-url 'wss://polkadot-collectives-rpc.polkadot.io' \
  --governance-chain-url 'wss://kusama-asset-hub-rpc.polkadot.io' \
  --bridge-hub-polkadot-url 'wss://polkadot-bridge-hub-rpc.polkadot.io' \
  --bridge-hub-kusama-url 'wss://kusama-bridge-hub-rpc.polkadot.io' \
  --call-to-create-fellowship-referendum '0x3d003e0201fc1f0005010100a10f05082f0000310202090300a10f00010004060300885e003ad2bf340fd1fe8c8434d8ac346d6afc77e7bb2d1c76340d47a0c2983225e64b010a000000' \
  --call-to-create-governance-referendum '0x5c005d0d02d183ea00b7326c6121ce8569a3d9ca4eb3a2bc2ab4cf1e326ac02bec712ff69223010000010a000000' \
  --verbose
```

Notes:

- A fellowship referendum is required (`--fellowship <id>` or `--call-to-create-fellowship-referendum`); the governance referendum is optional.
- `--asset-hub-polkadot-url`, `--bridge-hub-polkadot-url` and `--bridge-hub-kusama-url` default to the canonical polkadot.io RPCs (shown explicitly above) — override them to fork at a specific block (`url,block`) or use a chopsticks YAML config.
- `--asset-hub-kusama-url` is redundant when bridged: it defaults to `--governance-chain-url` (they are the same chain) and must match it if given.
- Extra chains passed via `--additional-chains` (e.g. the Polkadot/Kusama relays) are auto-routed onto the correct side of the bridge.
- Only the Polkadot fellowship → Kusama governance direction is currently supported.

## Local Development

```bash
yarn install
yarn build

# Run locally
yarn cli test \
  --governance-chain-url wss://asset-hub-polkadot-rpc.n.dwellir.com \
  --referendum 1777
```

## Options

| Flag | Description |
| --- | --- |
| `--governance-chain-url <url>` | Governance chain RPC endpoint. Format: `url` or `url,block` (e.g., `wss://polkadot.io,12345`) |
| `-r, --referendum <id>` | Main governance referendum ID to test |
| `--fellowship-chain-url <url>` | Fellowship chain RPC endpoint. Format: `url` or `url,block` (required when using `--fellowship`) |
| `-f, --fellowship <id>` | Fellowship referendum ID for whitelisting scenarios |
| `-p, --port <port>` | Local Chopsticks starting port (default: `8000`) |
| `--pre-call <hex>` | Hex string of call to execute before the main referendum (via Scheduler.Inline) |
| `--pre-origin <origin>` | Origin for pre-execution call (e.g., `"Root"`, `"WhitelistedCaller"`, `"Origins.Treasurer"`) |
| `--additional-chains <urls>` | Comma-separated list of additional chain URLs to monitor for XCM events. Format: `url` or `url,block` |
| `--call-to-create-governance-referendum <hex>` | Call data to create a governance referendum (hex). Mutually exclusive with `--referendum` |
| `--call-to-note-preimage-for-governance-referendum <hex>` | Call data to note preimage for governance referendum (hex, optional) |
| `--call-to-create-fellowship-referendum <hex>` | Call data to create a fellowship referendum (hex). Mutually exclusive with `--fellowship` |
| `--call-to-note-preimage-for-fellowship-referendum <hex>` | Call data to note preimage for fellowship referendum (hex, optional) |
| `--asset-hub-polkadot-url <url>` | Polkadot Asset Hub RPC endpoint (bridged scenario). Defaults to `wss://polkadot-asset-hub-rpc.polkadot.io` |
| `--bridge-hub-polkadot-url <url>` | Polkadot Bridge Hub RPC endpoint (bridged scenario). Defaults to `wss://polkadot-bridge-hub-rpc.polkadot.io` |
| `--asset-hub-kusama-url <url>` | Kusama Asset Hub RPC endpoint (bridged scenario). Defaults to `--governance-chain-url` and must match it |
| `--bridge-hub-kusama-url <url>` | Kusama Bridge Hub RPC endpoint (bridged scenario). Defaults to `wss://kusama-bridge-hub-rpc.polkadot.io` |
| `--bridge-pump-rounds <n>` | Max bridge pump rounds before giving up (bridged scenario, default: `8`) |
| `-v, --verbose` | Enable verbose logging |
| `--no-cleanup` | Keep Chopsticks instance running after test |
| `-h, --help` | Display help for command |

## Dev Scripts

```bash
yarn build       # compile to dist/
yarn cli test    # run directly with ts-node
yarn lint        # check code with eslint
yarn lint:fix    # fix code with eslint + prettier
yarn format      # format code with prettier
```

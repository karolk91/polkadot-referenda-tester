# Polkadot Referenda Tester

CLI for dry-running Polkadot/Kusama referenda against local Chopsticks forks.

## Usage

Run directly from GitHub without installing:

```bash
# Single-chain execution
npx github:karolk91/polkadot-referenda-tester test \
  --governance-chain-url wss://polkadot-rpc.dwellir.com \
  --referendum 1777

# With fellowship companion
npx github:karolk91/polkadot-referenda-tester test \
  --governance-chain-url wss://polkadot-rpc.dwellir.com \
  --fellowship-chain-url wss://polkadot-collectives-rpc.polkadot.io \
  --referendum 1777 \
  --fellowship 425
```

## Local Development

```bash
yarn install
yarn build

# Run locally
yarn cli test \
  --governance-chain-url wss://polkadot-rpc.dwellir.com \
  --referendum 1777
```

## Options

| Flag | Description |
| --- | --- |
| `--governance-chain-url <url>` | Governance chain RPC endpoint. Format: `url` or `url,block` (e.g., `wss://polkadot.io,12345`) **Required** |
| `-r, --referendum <id>` | Main governance referendum ID to test **Required** |
| `--fellowship-chain-url <url>` | Fellowship chain RPC endpoint. Format: `url` or `url,block` (required when using `--fellowship`) |
| `-f, --fellowship <id>` | Fellowship referendum ID for whitelisting scenarios |
| `-p, --port <port>` | Local Chopsticks starting port (default: `8000`) |
| `--pre-call <hex>` | Hex string of call to execute before the main referendum (via Scheduler.Inline) |
| `--pre-origin <origin>` | Origin for pre-execution call (e.g., `"Root"`, `"WhitelistedCaller"`, `"Origins.Treasurer"`) |
| `--additional-chains <urls>` | Comma-separated list of additional chain URLs to monitor for XCM events. Format: `url` or `url,block` |
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

---
name: test-ref
description: Dry-run a Polkadot or Kusama governance referendum using Chopsticks. Invoke when the user wants to test, simulate, or dry-run a referendum, or asks about testing governance proposals.
argument-hint: "1840 with fellowship 476 on polkadot with all chains"
allowed-tools: Bash, Read, Glob, Grep
user-invocable: true
---

# Test Referendum Skill

Dry-run Polkadot/Kusama governance referenda using the polkadot-referenda-tester CLI tool and summarize the results.

## Step 1: Parse Arguments

Parse `$ARGUMENTS` to extract the following. If no arguments are provided, ask the user what referendum they want to test.

### Referendum IDs
- **Governance referendum ID**: The first standalone number, or a number after "referendum", "ref", or "governance".
- **Fellowship referendum ID**: A number after "fellowship" or "with fellowship".

### Network
- Look for "polkadot" (default if not specified), "kusama" or "ksm".
- If the user provides a custom `wss://` URL, use it directly instead of the defaults.

### Bridged Scenario (Polkadot Fellowship → Kusama Governance)
The tool **auto-detects** a bridged scenario when the fellowship chain resolves to the **Polkadot** network and the governance chain resolves to the **Kusama** network (e.g. `--fellowship-chain-url` on Polkadot Collectives + `--governance-chain-url` on Kusama Asset Hub). No flag toggles it — the network mismatch is the trigger.

Recognize this from the user's request when they mention: "bridge", "bridged", "cross-network", "Polkadot fellowship → Kusama", or supply a Polkadot Collectives fellowship URL alongside a Kusama Asset Hub governance URL. See **Step 3 (Bridged)** for the extra flags this path needs.

- Only the direction **Polkadot fellowship → Kusama governance** is supported. The reverse (Kusama fellowship → Polkadot governance) errors out — surface that to the user rather than trying to work around it.
- A bridged run **requires a fellowship referendum** (`-f <id>` or `--call-to-create-fellowship-referendum <hex>`). The whitelisted call originates on Collectives and is bridged to Kusama.

### All Chains Mode
- If the user says "all chains", "with all system chains", "monitor all", or "all parachains", set the all-chains flag to include all system parachains as `--additional-chains`.
- This works in **both** the single-network and bridged paths. In the bridged path the tool classifies each additional chain by network, routes it onto the correct side, and skips duplicates of the core bridge chains (see Step 2).

### Hex Call Data (preimage/creation mode)
- Strings starting with `0x` are hex call data. Determine the flag from context:
  - After "create governance referendum" or "governance call" -> `--call-to-create-governance-referendum`
  - After "create fellowship referendum" or "fellowship call" -> `--call-to-create-fellowship-referendum`
  - After "governance preimage" or "note preimage" -> `--call-to-note-preimage-for-governance-referendum`
  - After "fellowship preimage" -> `--call-to-note-preimage-for-fellowship-referendum`
  - If ambiguous, ask the user.

### Other Options
- "keep running" or "no cleanup" -> add `--no-cleanup`
- "at block 12345" or URL with `,12345` suffix -> block pinning

## Step 2: Map Network to URLs

### Polkadot (post-AHM, default)
- Governance: `wss://asset-hub-polkadot-rpc.n.dwellir.com`
- Fellowship: `wss://polkadot-collectives-rpc.polkadot.io`
- All additional chains value:
  `wss://polkadot-rpc.n.dwellir.com,wss://asset-hub-polkadot-rpc.n.dwellir.com,wss://polkadot-bridge-hub-rpc.polkadot.io,wss://polkadot-collectives-rpc.polkadot.io,wss://polkadot-coretime-rpc.polkadot.io,wss://polkadot-people-rpc.polkadot.io`

### Kusama
- Governance: `wss://asset-hub-kusama-rpc.n.dwellir.com`
- Fellowship: `wss://kusama-rpc.n.dwellir.com` (fellowship referenda on Kusama live on the relay chain, not a separate Collectives parachain)
- All additional chains value:
  `wss://kusama-rpc.n.dwellir.com,wss://asset-hub-kusama-rpc.n.dwellir.com,wss://kusama-bridge-hub-rpc.polkadot.io,wss://encointer-kusama-rpc.n.dwellir.com,wss://kusama-coretime-rpc.polkadot.io,wss://kusama-people-rpc.polkadot.io`

The tool deduplicates additional chains that overlap with the governance/fellowship (and, in the bridged path, the core bridge) endpoints. Dedup is by **chain identity** (network + runtime `spec_name`), not just raw URL — so the same chain reached via a different host (e.g. `kusama-asset-hub-rpc.polkadot.io` vs `asset-hub-kusama-rpc.n.dwellir.com`) is correctly skipped. It is safe to include the full list.

### Bridged endpoints (only for the bridged scenario)
The bridged path spawns five core chains: Polkadot Collectives + Asset Hub Polkadot + Bridge Hub Polkadot, and Kusama Asset Hub + Bridge Hub Kusama. When a flag isn't supplied the tool defaults to these public RPCs:
- `--asset-hub-polkadot-url` → `wss://polkadot-asset-hub-rpc.polkadot.io`
- `--bridge-hub-polkadot-url` → `wss://polkadot-bridge-hub-rpc.polkadot.io`
- `--bridge-hub-kusama-url` → `wss://kusama-bridge-hub-rpc.polkadot.io`
- `--asset-hub-kusama-url` → defaults to `--governance-chain-url` (they name the same AHK chain; if you pass it, it MUST match the governance URL)

In the bridged path, `--additional-chains` is classified per network and routed onto the correct side; relays take the reserved relay key (and are advanced during the bridge pump) and non-bridge system parachains are spawned, HRMP-wired, advanced during the pump, and **also settled after the AHK public referendum** so any `authorize_upgrade` fan-out actually executes on them.

### Parachain ID to Name Mapping
Use this to label chains in the summary:
- 0 / `Here` (parent) = Relay Chain
- 1000 = Asset Hub
- 1001 = Collectives (Polkadot) / Encointer (Kusama)
- 1002 = Bridge Hub
- 1004 = People
- 1005 = Coretime

## Step 3: Build the CLI Command

Working directory: the project root (where `package.json` is). `yarn cli` runs via ts-node from source — no build step needed.

Base: `yarn cli test -v`

### Single-network rules
- Governance ref ID provided -> add `-r <id>` and `--governance-chain-url <url>`
- Fellowship ref ID provided -> add `-f <id>` and `--fellowship-chain-url <url>`
- Fellowship chain URL is only needed when a fellowship referendum is involved.
- All chains mode -> add `--additional-chains <comma-separated-urls>`
- Hex governance creation call -> add `--call-to-create-governance-referendum <hex>`
- Hex fellowship creation call -> add `--call-to-create-fellowship-referendum <hex>`
- Hex governance preimage -> add `--call-to-note-preimage-for-governance-referendum <hex>`
- Hex fellowship preimage -> add `--call-to-note-preimage-for-fellowship-referendum <hex>`
- No cleanup -> add `--no-cleanup`
- MUTUALLY EXCLUSIVE: `--referendum` vs `--call-to-create-governance-referendum`
- MUTUALLY EXCLUSIVE: `--fellowship` vs `--call-to-create-fellowship-referendum`

### Bridged rules (Polkadot fellowship → Kusama governance)
Triggered automatically when `--fellowship-chain-url` is on Polkadot and `--governance-chain-url` is on Kusama. In addition to the single-network rules:
- `--fellowship-chain-url` = Polkadot Collectives (`wss://polkadot-collectives-rpc.polkadot.io`)
- `--governance-chain-url` = Kusama Asset Hub (`wss://kusama-asset-hub-rpc.polkadot.io`)
- A fellowship referendum is REQUIRED (`-f <id>` or `--call-to-create-fellowship-referendum <hex>`).
- `--bridge-hub-polkadot-url` and `--bridge-hub-kusama-url`: pass through if the user supplies them; otherwise the tool uses the public-RPC defaults (Step 2). For an "all chains" Kusama request, Bridge Hub Kusama is already a core chain — it is deduped automatically if also present in `--additional-chains`.
- `--asset-hub-polkadot-url`: optional, defaults to the public RPC.
- `--asset-hub-kusama-url`: omit (defaults to governance URL). Only pass it if it equals `--governance-chain-url`.
- `--bridge-pump-rounds <n>`: optional, default 8. Increase only if the bridge pump reports it didn't drain.
- **Second-half Kusama governance referendum** — the step that actually *dispatches* the bridged whitelisted call. It runs when you provide EITHER:
  - `-r <id>` — force-approve an **existing** AHK referendum (typically on the `WhitelistedCaller` track), or
  - `--call-to-create-governance-referendum <hex>` — create one dynamically.
  - If you provide neither, only the **bridge crossing** runs (the call is whitelisted on AHK via `Whitelist.CallWhitelisted` but never dispatched). Tell the user when their command will stop at the crossing.

## Step 4: Execute

1. Show the user the exact command you will run.
2. Run the command using Bash with `run_in_background: true` and `timeout: 600000` (10 minutes). Redirect output: `<command> 2>&1 | tee /tmp/prt-output-$(date +%s).txt`
3. Tell the user the test is running:
   - Single-network: typically 30–120 seconds (longer with additional chains).
   - **Bridged**: typically 2–4 minutes; **longer (5+ min) when `--additional-chains` includes the Kusama relay**, since forking relay state is heavy.
4. When the background task completes, read the output file with the Read tool.

## Step 5: Parse Output

Scan the output file for these key data points:

### Referendum Info
- Track name (from "track" field in parsed referendum info)
- Origin (from "origin" field)
- Proposal type: Inline vs Lookup (with hash)

### Key Events (per chain section)
- `Scheduler.Dispatched` -> `result.success` (true/false) — was the referendum dispatched?
- `Whitelist.WhitelistedCallDispatched` -> `result.success` — was the whitelisted call executed?
- `System.UpgradeAuthorized` -> extract `code_hash` — runtime upgrade authorization
- `PolkadotXcm.Sent` -> extract destination parachain IDs from `destination.interior` — XCM routing
- `XcmpQueue.XcmpMessageSent` — HRMP message sent
- `ParachainSystem.UpwardMessageSent` — UMP message sent to relay
- `MessageQueue.Processed` -> `success` field and `origin` (Sibling/Ump) — XCM delivery confirmation
- `Utility.BatchCompleted` — batch call completed
- `Balances.Transfer` — fund movements
- Any lines with "failed", "Error", or error indicators

### Bridged-only markers
- `Setting Up Bridged Multi-Chain Environment` — confirms the bridged path was taken.
- Classification log lines: `Skipping additional chain … already in the bridge topology as …` (identity dedup) and `Bridged topology: monitoring <chain> (<kind>) as key '<key>'` (relay → `kusama`, parachains → `extra_<n>`).
- `Bridge Pump …` then `Bridge Delivery Verification` and `Bridge delivery verified — all happy-path markers fired` — the cross-network delivery succeeded.
  - `BridgeKusamaMessages.MessageAccepted` (on Bridge Hub Polkadot), `BridgePolkadotMessages.MessagesReceived` + `XcmpQueue.XcmpMessageSent` (on Bridge Hub Kusama), `MessageQueue.Processed{success:true}` + `Whitelist.CallWhitelisted` (on Asset Hub Kusama).
  - `Delivered N/N bridge message(s); 0 failure(s)`.
- `Bridged-Target Public Referendum (AHK whitelistedcaller)` — the second-half Kusama public referendum that dispatches the whitelisted call.
- `Downstream Fan-Out Settlement (Kusama system chains)` — followed by per-chain lines `<chain>: System.UpgradeAuthorized — code_hash=0x…` (or `<chain>: no UpgradeAuthorized (MessageQueue.Processed{success}=x/y)`). These are the fan-out targets actually executing the bridged call.

### Final Status
- Single-network: "Both referenda executed successfully", "Fellowship workflow completed", "Referendum executed successfully", or error messages.
- Bridged: `Fellowship referendum #… executed successfully!`, `Bridge delivery verified …`, `AHK Public referendum #… executed successfully!`, then `Workflow completed`.

## Step 6: Generate ASCII Tree Summary

Build a structured ASCII tree. Use the expanded sub-tree style (nested `├──`/`└──` per chain) — it reads better than flat lists or box-drawing tables.

### Single-network template

```
Fellowship Ref #<id> (<chain-name>)
│  Track: <track> | Origin: <origin>
│  Result: PASSED ✅ | FAILED ❌
│
├── Scheduler.Dispatched: SUCCESS
└── HRMP -> Asset Hub (1000)

Main Governance Ref #<id> (<chain-name>)
│  Track: <track> | Origin: <origin>
│  Proposal: <Inline|Lookup> (hash: <hash>)
│  Result: PASSED ✅ | FAILED ❌
│
├── Scheduler.Dispatched: SUCCESS
├── Whitelist.WhitelistedCallDispatched: SUCCESS  (if present)
├── System.UpgradeAuthorized: <code_hash>         (if present, for local chain)
│
└── XCM Messages:
    ├── UMP -> Relay Chain
    ├── HRMP -> Collectives (1001)
    ├── HRMP -> Bridge Hub (1002)
    ├── HRMP -> Coretime (1005)
    └── HRMP -> People (1004)

Post-Execution XCM Delivery
│
├── Relay:
│   ├── System.UpgradeAuthorized (0x<full_hash>)
│   └── MessageQueue.Processed: SUCCESS ✅
│  … (one block per chain that received and processed XCM) …

Upgrade Hashes
| Chain        | code_hash                                                          |
|--------------|--------------------------------------------------------------------|
| Relay        | 0x...                                                              |
| Asset Hub    | 0x...                                                              |
| ...          | ...                                                                |

Overall: ALL PASSED ✅ | FAILURES DETECTED ❌
```

### Bridged template (Polkadot fellowship → Kusama governance)

```
Fellowship Ref #<id> (Polkadot Collectives)
│  Track: <track> | Origin: <origin>
│  Proposal: <Inline|Lookup>
│  Result: PASSED ✅ | FAILED ❌
│
├── Scheduler.Dispatched: SUCCESS
└── Bridged whitelist_call → Kusama Asset Hub

Bridge Crossing (Polkadot → Kusama)   Delivered <n>/<n>, 0 failures  ✅
│
├── Bridge Hub Polkadot
│   └── BridgeKusamaMessages.MessageAccepted (lane 0x…)
├── Bridge Hub Kusama
│   ├── BridgePolkadotMessages.MessagesReceived ×<n>
│   ├── XcmpQueue.XcmpMessageSent ×<n>
│   └── System.ExtrinsicFailed = 0
└── Asset Hub Kusama
    ├── MessageQueue.Processed{success:true} = <n>   (origin: Sibling 1000)
    └── Whitelist.CallWhitelisted ✅

Main Governance Ref #<id> (Kusama Asset Hub)
│  Track: <track> | Origin: <origin>
│  Proposal: <Inline|Lookup> (hash: <hash>)
│  Result: PASSED ✅ | FAILED ❌
│
├── Whitelist.WhitelistedCallDispatched: SUCCESS ✅
├── Scheduler.Dispatched: SUCCESS ✅
├── System.UpgradeAuthorized (Asset Hub Kusama) ✅ (0x<full_hash>)   (if upgrade)
│
└── XCM Fan-out (authorize_upgrade) — executed on every target:   (if fan-out)
    ├── UMP  → Relay Chain
    │   └── System.UpgradeAuthorized ✅ (0x<full_hash>)
    ├── HRMP → Encointer (1001)
    │   └── System.UpgradeAuthorized ✅ (0x<full_hash>)
    ├── HRMP → Bridge Hub (1002)
    │   └── System.UpgradeAuthorized ✅ (0x<full_hash>)
    ├── HRMP → People (1004)
    │   └── System.UpgradeAuthorized ✅ (0x<full_hash>)
    └── HRMP → Coretime (1005)
        └── System.UpgradeAuthorized ✅ (0x<full_hash>)

Upgrade Hashes   (only when an upgrade was authorized)
| Chain                    | code_hash |
|--------------------------|-----------|
| Asset Hub Kusama (1000)  | 0x...     |
| Kusama Relay             | 0x...     |
| ...                      | ...       |

Overall: ALL PASSED ✅ | FAILURES DETECTED ❌  —  <m>/<n> chains authorized their upgrade
```

Notes for the bridged tree:
- Each fan-out target authorizes its **own** runtime WASM, so the code hashes differ per chain — render the actual per-chain hash from the `Downstream Fan-Out Settlement` lines, never assume they match Asset Hub Kusama's.
- Asset Hub Kusama is the fan-out **source**; its own `System.UpgradeAuthorized` appears in the public-referendum section, not the downstream settlement block.
- If the dispatched governance call isn't an upgrade (e.g. a treasury spend), drop the `System.UpgradeAuthorized` / fan-out / Upgrade Hashes parts and show whatever events the call actually produced.

After the tree, add a 1-2 sentence plain-English explanation:
- Multiple `System.UpgradeAuthorized` events -> "Runtime upgrade referendum authorizing new WASM code across all system chains."
- Bridged + per-chain upgrades -> "Network-wide Kusama runtime upgrade, fast-tracked through Polkadot's Fellowship: the whitelisted call is bridged to Kusama Asset Hub and fans `authorize_upgrade` out to every Kusama system chain."
- `Whitelist.WhitelistedCallDispatched` present -> "Whitelisted call executed (fast-tracked via fellowship approval)."
- Only `Balances.Transfer` -> "Fund transfer referendum."
- XCM to specific subset of chains -> "Cross-chain operation targeting [chain names]."

If any failures occurred, highlight them prominently at the top of the summary.

## Edge Cases

- **Bridged scenario**: Auto-detected from Polkadot fellowship + Kusama governance. Requires a fellowship referendum. Use the bridged command rules (Step 3) and bridged summary template (Step 6).
- **Unsupported bridge direction**: Kusama fellowship → Polkadot governance is rejected by the tool with an "Unsupported direction" error. Don't try to route it through the single-network path — relay the error and suggest the supported direction.
- **Bridged `--additional-chains` dedup**: Asset Hub Kusama and Bridge Hub Kusama in an "all chains" list are deduped automatically (they're core bridge chains). Expect `Skipping additional chain … already in the bridge topology …` log lines — that's correct, not an error.
- **Governance-only (no fellowship)**: Skip the fellowship section entirely. Only require `--governance-chain-url`.
- **Fellowship-only (no governance)**: Skip the governance section. Only require `--fellowship-chain-url`.
- **Preimage/call creation mode**: Note in the output that referenda were created dynamically. Look for the assigned referendum IDs in the tool output (e.g. `Fellowship referendum #544 created`, `Governance referendum #651 created`).
- **Run errors out early**: If no `Scheduler.Dispatched` event found in the output, the run likely failed. Show the last 30 lines of output for debugging.
- **No arguments at all**: Ask the user what referendum they want to test and on which network.
- **Ambiguous hex data**: If you cannot determine whether hex is a governance call, fellowship call, or preimage, ask the user to clarify.

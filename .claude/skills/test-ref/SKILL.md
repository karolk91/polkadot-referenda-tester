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

### All Chains Mode
- If the user says "all chains", "with all system chains", "monitor all", or "all parachains", set the all-chains flag to include all system parachains as `--additional-chains`.

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

The tool automatically deduplicates URLs that overlap with governance/fellowship endpoints, so it is safe to include all URLs.

### Parachain ID to Name Mapping
Use this to label chains in the summary:
- 0 / `Here` (parent) = Relay Chain
- 1000 = Asset Hub
- 1001 = Collectives (Polkadot) / Encointer (Kusama)
- 1002 = Bridge Hub
- 1004 = Coretime
- 1005 = People

## Step 3: Build the CLI Command

Working directory: the project root (where `package.json` is).

Base: `yarn cli test -v`

Rules:
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

## Step 4: Execute

1. Show the user the exact command you will run.
2. Run the command using Bash with `run_in_background: true` and `timeout: 600000` (10 minutes). Redirect output: `<command> 2>&1 | tee /tmp/prt-output-$(date +%s).txt`
3. Tell the user the test is running and typically takes 30-120 seconds (longer with additional chains).
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

### Final Status
- Look for "Both referenda executed successfully", "Fellowship workflow completed", "Referendum executed successfully", or error messages.

## Step 6: Generate ASCII Tree Summary

Build a structured ASCII tree. Adapt the template based on what referenda were tested:

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
    ├── HRMP -> Coretime (1004)
    └── HRMP -> People (1005)

Post-Execution XCM Delivery
│
├── Relay:
│   ├── System.UpgradeAuthorized (0x<full_hash>)
│   └── MessageQueue.Processed: SUCCESS ✅
│
├── Collectives:
│   ├── System.UpgradeAuthorized (0x<full_hash>)
│   └── MessageQueue.Processed: SUCCESS ✅
│
├── Bridge Hub:
│   ├── System.UpgradeAuthorized (0x<full_hash>)
│   └── MessageQueue.Processed: SUCCESS ✅
│
├── Coretime:
│   ├── System.UpgradeAuthorized (0x<full_hash>)
│   └── MessageQueue.Processed: SUCCESS ✅
│
└── People:
    ├── System.UpgradeAuthorized (0x<full_hash>)
    └── MessageQueue.Processed: SUCCESS ✅

Upgrade Hashes
| Chain        | code_hash                                                          |
|--------------|--------------------------------------------------------------------|
| Relay        | 0x...                                                              |
| Asset Hub    | 0x...                                                              |
| ...          | ...                                                                |

Overall: ALL PASSED ✅ | FAILURES DETECTED ❌
```

After the tree, add a 1-2 sentence plain-English explanation:
- Multiple `System.UpgradeAuthorized` events -> "Runtime upgrade referendum authorizing new WASM code across all system chains."
- `Whitelist.WhitelistedCallDispatched` present -> "Whitelisted call executed (fast-tracked via fellowship approval)."
- Only `Balances.Transfer` -> "Fund transfer referendum."
- XCM to specific subset of chains -> "Cross-chain operation targeting [chain names]."

If any failures occurred, highlight them prominently at the top of the summary.

## Edge Cases

- **Governance-only (no fellowship)**: Skip the fellowship section entirely. Only require `--governance-chain-url`.
- **Fellowship-only (no governance)**: Skip the governance section. Only require `--fellowship-chain-url`.
- **Preimage/call creation mode**: Note in the output that referenda were created dynamically. Look for the assigned referendum IDs in the tool output.
- **Run errors out early**: If no `Scheduler.Dispatched` event found in the output, the run likely failed. Show the last 30 lines of output for debugging.
- **No arguments at all**: Ask the user what referendum they want to test and on which network.
- **Ambiguous hex data**: If you cannot determine whether hex is a governance call, fellowship call, or preimage, ask the user to clarify.

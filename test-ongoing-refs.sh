#!/bin/bash

# Parse arguments
CHAIN_URL=""
IS_FELLOWSHIP=false

# Show usage
usage() {
  echo "Usage: $0 <URL> [--fellow]"
  echo ""
  echo "Arguments:"
  echo "  <URL>       Chain RPC endpoint URL (required). Format: url or url,block"
  echo "  --fellow    Indicate this is fellowship governance (optional)"
  echo ""
  echo "Examples:"
  echo "  $0 wss://polkadot-rpc.dwellir.com,28390821"
  echo "  $0 wss://polkadot-collectives-rpc.polkadot.io,7473112 --fellow"
  exit 1
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --fellow)
      IS_FELLOWSHIP=true
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      if [ -z "$CHAIN_URL" ]; then
        CHAIN_URL="$1"
      else
        echo "Error: Unexpected argument: $1"
        usage
      fi
      shift
      ;;
  esac
done

# Validate URL is provided
if [ -z "$CHAIN_URL" ]; then
  echo "Error: Chain URL is required"
  usage
fi

# Determine which flags to use
if [ "$IS_FELLOWSHIP" = true ]; then
  CHAIN_URL_FLAG="--fellowship-chain-url"
  REF_ID_FLAG="--fellowship"
  GOVERNANCE_TYPE="fellowship"
else
  CHAIN_URL_FLAG="--governance-chain-url"
  REF_ID_FLAG="--referendum"
  GOVERNANCE_TYPE="main governance"
fi

echo "=== Fetching ongoing $GOVERNANCE_TYPE referendums ==="
echo "Chain URL: $CHAIN_URL"
echo ""

# Fetch and parse ongoing referendums, skip track=1
REF_IDS=$(npx -y github:karolk91/polkadot-referenda-tester list \
  $CHAIN_URL_FLAG "$CHAIN_URL" \
  --status ongoing 2>&1 | \
  grep -E '^[0-9]+,ongoing' | \
  grep -v 'track=1' | \
  cut -d',' -f1)

# Check if we found any referendums
if [ -z "$REF_IDS" ]; then
  echo "No ongoing referendums found (excluding track=1)"
  exit 0
fi

echo "Found referendum IDs to test:"
echo "$REF_IDS"
echo ""

# Arrays to track results
PASSED=()
FAILED=()

# Test each referendum
for REF_ID in $REF_IDS; do
  echo "========================================"
  echo "Testing $GOVERNANCE_TYPE Referendum #$REF_ID"
  echo "========================================"
  echo ""

  npx -y github:karolk91/polkadot-referenda-tester test \
    $CHAIN_URL_FLAG "$CHAIN_URL" \
    $REF_ID_FLAG "$REF_ID"

  TEST_RESULT=$?

  echo ""
  if [ $TEST_RESULT -eq 0 ]; then
    echo "✓ Referendum #$REF_ID - PASSED"
    PASSED+=("$REF_ID")
  else
    echo "✗ Referendum #$REF_ID - FAILED (exit code: $TEST_RESULT)"
    FAILED+=("$REF_ID")
  fi
  echo ""
done

# Summary
echo "========================================"
echo "           SUMMARY"
echo "========================================"
echo ""
echo "Total tested: $(( ${#PASSED[@]} + ${#FAILED[@]} ))"
echo "Passed: ${#PASSED[@]}"
echo "Failed: ${#FAILED[@]}"
echo ""

if [ ${#PASSED[@]} -gt 0 ]; then
  echo "✓ Passed referendums: ${PASSED[*]}"
fi

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "✗ Failed referendums: ${FAILED[*]}"
  exit 1
fi

echo ""
echo "All tests passed!"
exit 0

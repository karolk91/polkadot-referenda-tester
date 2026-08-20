import { BuildBlockMode } from '@acala-network/chopsticks-core';
import * as path from 'path';
import { ALICE_ACCOUNT_INJECTION, FELLOWSHIP_STORAGE_INJECTION } from './storage-constants';

/** Which canned storage override (if any) to merge into a chain's `import-storage`. */
export type StorageInjection = 'fellowship' | 'alice-account';

/**
 * Build a single chain's Chopsticks config with the tool's standard precedence layering
 * (highest precedence last wins):
 *   1. tool defaults — `db`, `runtime-log-level`
 *   2. user's YAML baseConfig — can override `runtime-log-level`, add `wasm-override`, etc.
 *   3. tool-mandatory test-harness settings — `build-block-mode` / `mock-signature-host` /
 *      `allow-unresolved-imports` cannot be disabled by the user
 *   4. explicit endpoint / block from the URL flag — always win
 *   5. `import-storage` — the user's block shallow-merged with the tool's storage injection
 *      (the tool wins per-pallet, so test mechanics like funding Alice are never silently
 *      disabled by a user-provided YAML)
 *
 * Shared by {@link ChainTopologyBuilder} and {@link BridgeTopologyBuilder}; they differ only
 * in the default `runtime-log-level` (passed via {@link runtimeLogLevel}).
 */
export function buildChopsticksChainConfig(
  endpoint: string,
  block: number | undefined,
  storageInjection: StorageInjection | undefined,
  userBaseConfig: Record<string, unknown> | undefined,
  runtimeLogLevel: number
): Record<string, unknown> {
  const toolDefaults: Record<string, unknown> = {
    db: path.join(process.cwd(), '.chopsticks-db'),
    'runtime-log-level': runtimeLogLevel,
  };

  const mandatory: Record<string, unknown> = {
    endpoint,
    'build-block-mode': BuildBlockMode.Manual,
    'mock-signature-host': true,
    'allow-unresolved-imports': true,
  };
  if (block !== undefined) {
    mandatory.block = block;
  }

  const config: Record<string, unknown> = {
    ...toolDefaults,
    ...(userBaseConfig ?? {}),
    ...mandatory,
  };

  const injection =
    storageInjection === 'fellowship'
      ? FELLOWSHIP_STORAGE_INJECTION
      : storageInjection === 'alice-account'
        ? ALICE_ACCOUNT_INJECTION
        : undefined;
  if (injection) {
    const existing =
      (userBaseConfig?.['import-storage'] as Record<string, unknown> | undefined) ?? {};
    config['import-storage'] = { ...existing, ...injection };
  }

  return config;
}

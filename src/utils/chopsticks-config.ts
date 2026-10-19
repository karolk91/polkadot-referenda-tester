import { BuildBlockMode } from '@acala-network/chopsticks-core';
import type { setupContextWithConfig } from '@acala-network/chopsticks-testing';
import { createHash } from 'crypto';
import * as path from 'path';
import type { ParsedEndpoint } from './chain-endpoint-parser';
import { ALICE_ACCOUNT_INJECTION, FELLOWSHIP_STORAGE_INJECTION } from './storage-constants';

/** Which predefined storage override (if any) to merge into a chain's `import-storage`. */
export type StorageInjection = 'fellowship' | 'alice-account';

/**
 * Per-chain SQLite cache path. Each forked chain needs its OWN db file: when several chains are
 * forked together (e.g. governance + `--additional-chains`), sharing one file makes the concurrent
 * opens fail with `SQLITE_CANTOPEN`. Deriving the filename from the endpoint reuses the storage
 * cache across runs (same endpoint → same file) and uses a different file per chain. The slug is
 * truncated, so two endpoints can share a prefix; the digest of the full endpoint makes their
 * file names differ.
 */
function dbPath(endpoint: string): string {
  const slug = endpoint
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  const digest = createHash('sha1').update(endpoint).digest('hex').slice(0, 10);
  return path.join(process.cwd(), '.chopsticks-db', `${slug || 'chain'}-${digest}.sqlite`);
}

const STORAGE_INJECTIONS: Record<StorageInjection, Record<string, unknown>> = {
  fellowship: FELLOWSHIP_STORAGE_INJECTION,
  'alice-account': ALICE_ACCOUNT_INJECTION,
};

export type ForkConfig = Parameters<typeof setupContextWithConfig>[0] & { endpoint: string };

/**
 * Build a single chain's Chopsticks config with the tool's standard precedence layering
 * (highest precedence last wins):
 *   1. tool defaults — `db`, `runtime-log-level`
 *   2. user's YAML baseConfig — can override `runtime-log-level`, add `wasm-override`, etc.
 *   3. tool-mandatory test-harness settings — `build-block-mode` / `mock-signature-host` /
 *      `allow-unresolved-imports` cannot be disabled by the user
 *   4. explicit endpoint / block from the URL flag — always take precedence
 *   5. `import-storage` — the user's block shallow-merged with the tool's storage injection
 *      (the tool's value takes precedence per-pallet, so a user-provided YAML cannot disable
 *      test mechanics such as funding Alice)
 */
export function buildChopsticksChainConfig(
  endpoint: ParsedEndpoint,
  options: { injection?: StorageInjection; runtimeLogLevel: number }
): ForkConfig {
  const injection = options.injection && STORAGE_INJECTIONS[options.injection];
  const userImportStorage = endpoint.baseConfig?.['import-storage'] as
    | Record<string, unknown>
    | undefined;
  return {
    db: dbPath(endpoint.url),
    'runtime-log-level': options.runtimeLogLevel,
    ...endpoint.baseConfig,
    endpoint: endpoint.url,
    'build-block-mode': BuildBlockMode.Manual,
    'mock-signature-host': true,
    'allow-unresolved-imports': true,
    ...(endpoint.block !== undefined && { block: endpoint.block }),
    ...(injection && { 'import-storage': { ...userImportStorage, ...injection } }),
  } as ForkConfig;
}

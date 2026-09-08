import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Logger } from '../utils/logger';

/**
 * A genuine dynamic `import()` that survives TypeScript's CommonJS emit. With `module: CommonJS`,
 * `tsc` rewrites a literal `import()` into `require()`, which cannot load ESM or `.ts` post-tests.
 * A direct `eval` keeps a real runtime `import()` that carries this module's host import callback
 * (so ESM and Node's `.ts` type stripping work); the specifier is inlined as an escaped string
 * literal so nothing from the surrounding scope is evaluated. (`new Function` does not work here —
 * a function built that way has no import callback: "A dynamic import callback was not specified".)
 */
function dynamicImport(specifier: string): Promise<unknown> {
  // biome-ignore lint/security/noGlobalEval: intentional — preserves dynamic import() in CJS output
  return eval(`import(${JSON.stringify(specifier)})`) as Promise<unknown>;
}

/** A live Chopsticks-forked chain handed to a post-test script. */
export interface PostTestChain {
  /** Human label, e.g. `Polkadot Asset Hub` or `Hydration`. */
  label: string;
  /** Runtime `spec_name`, e.g. `asset-hub-polkadot`, `hydradx`. */
  specName: string;
  /** `polkadot` | `kusama` | `unknown`. */
  network: string;
  /** `relay` | `system-parachain` | `parachain` | `unknown`. */
  kind: string;
  /** WebSocket endpoint of the running Chopsticks node (dev RPCs available). */
  wsEndpoint: string;
  /**
   * The live chopsticks-core `Blockchain` object for this fork (from `setupNetworks`). Build blocks
   * in-process via `chain.newBlock(params)` so cross-chain (`connectParachains`) HRMP delivery works;
   * a raw `dev_newBlock` over WS does not trigger sibling message delivery reliably. Typed loosely so
   * the post-test can cast to just the methods it needs.
   */
  chain: unknown;
}

/**
 * Context passed to a post-referendum test script. The referendum has already been executed on
 * `main`; every chain in `chains` (including `main`) is a live Chopsticks fork with the standard
 * `dev_newBlock` / `dev_setStorage` / `dev_timeTravel` RPCs available on its `wsEndpoint`. A script
 * connects with its own client (e.g. polkadot-api), drives the chains, and throws to fail.
 */
/**
 * Which referendum step of the run a post-test follows (1-based) and how many steps the run has,
 * plus the IDs that step executed (resolved after any creation call).
 */
export interface PostTestStepInfo {
  index: number;
  count: number;
  referendumId?: number;
  fellowshipReferendumId?: number;
}

export interface PostTestContext {
  /** The chain the referendum executed on. */
  main: PostTestChain;
  /** All forked chains, `main` included. */
  chains: PostTestChain[];
  /** Value of `--post-test-args`, parsed as JSON when possible, otherwise the raw string. */
  args: unknown;
  verbose: boolean;
  step: PostTestStepInfo;
}

/** A post-test module exports a function as `default`, `postTest`, or `run`. */
type PostTestFn = (context: PostTestContext) => void | Promise<void>;

function resolvePostTestFn(loaded: unknown): PostTestFn {
  if (typeof loaded === 'function') return loaded as PostTestFn;
  if (loaded && typeof loaded === 'object') {
    const record = loaded as Record<string, unknown>;
    for (const key of ['default', 'postTest', 'run']) {
      if (typeof record[key] === 'function') return record[key] as PostTestFn;
    }
  }
  throw new Error('Post-test module must export a function (as `default`, `postTest`, or `run`)');
}

function parseArgs(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Loads and runs a per-referendum post-test module against the live post-referendum network.
 *
 * The module is loaded with a dynamic `import()` so ESM post-tests (and the ESM-only polkadot-api
 * ecosystem they typically use) work even though this tool is CommonJS. `.js`/`.mjs`/`.cjs` load
 * directly; `.ts` relies on the host Node's type stripping (Node >= 22.18 / 23.6, or run with
 * `--experimental-strip-types`) — precompile to `.js` on older runtimes. Rethrows on failure so
 * the caller can surface a non-zero exit.
 */
export async function runPostTest(
  logger: Logger,
  modulePath: string,
  context: PostTestContext,
  argsRaw?: string,
  // Seam for tests: how the module URL is loaded. Production uses the real dynamic import.
  load: (specifier: string) => Promise<unknown> = dynamicImport
): Promise<void> {
  const resolved = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(process.cwd(), modulePath);

  logger.section('Post-Referendum Test');
  logger.info(`Running post-test: ${resolved}`);
  logger.info(
    `Chains available: ${context.chains.map((c) => `${c.label} (${c.wsEndpoint})`).join(', ')}`
  );

  let loaded: unknown;
  try {
    loaded = await load(pathToFileURL(resolved).href);
  } catch (error) {
    const hint = /\.ts$/.test(resolved)
      ? ' (loading a .ts module requires Node >= 22.18/23.6 with type stripping, or precompile to .js)'
      : '';
    throw new Error(
      `Failed to load post-test module ${resolved}: ${(error as Error).message}${hint}`
    );
  }

  const fn = resolvePostTestFn(loaded);
  const ctx: PostTestContext = { ...context, args: parseArgs(argsRaw) };
  await fn(ctx);
  logger.success('✓ Post-referendum test passed');
}

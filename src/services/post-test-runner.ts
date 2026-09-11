import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  BUNDLED_POST_TESTS_DIR,
  bundledPostTests,
  listBundledPostTests,
} from '../utils/bundled-post-tests';
import type { Logger } from '../utils/logger';

export { listBundledPostTests };

/**
 * True when the specifier names a file rather than a bundled post-test: absolute, containing a
 * path separator, or carrying a JS/TS extension. Anything else (`apply-authorized-upgrade`) is a
 * bundled name.
 */
function isPathSpecifier(specifier: string): boolean {
  return path.isAbsolute(specifier) || /[\\/]/.test(specifier) || /\.[cm]?[jt]s$/i.test(specifier);
}

/**
 * Turn a `--post-test` value into an absolute file path. A bare name resolves to a bundled
 * post-test with any supported extension. A value containing a path separator or a file extension
 * resolves against the working directory, so a user-supplied module works from any directory.
 */
export function resolvePostTestModule(
  modulePath: string,
  bundledDir: string = BUNDLED_POST_TESTS_DIR
): string {
  if (isPathSpecifier(modulePath)) return path.resolve(process.cwd(), modulePath);
  // This join produces a path for a name that does not exist; `runPostTest` then reports the
  // missing file as an error.
  return bundledPostTests(bundledDir).get(modulePath) ?? path.join(bundledDir, `${modulePath}.mjs`);
}

/**
 * A dynamic `import()` that remains a dynamic import after TypeScript's CommonJS emit. With
 * `module: CommonJS`, `tsc` rewrites a literal `import()` into `require()`, which cannot load ESM
 * or `.ts` post-tests. A direct `eval` produces a runtime `import()` that retains this module's
 * host import callback, so ESM and Node's `.ts` type stripping both work. The specifier is
 * inlined as an escaped string literal, so the code evaluates nothing from the surrounding scope.
 * `new Function` does not work here: a function built that way has no import callback and fails
 * with "A dynamic import callback was not specified".
 */
function dynamicImport(specifier: string): Promise<unknown> {
  // biome-ignore lint/security/noGlobalEval: intentional — preserves dynamic import() in CJS output
  return eval(`import(${JSON.stringify(specifier)})`) as Promise<unknown>;
}

/** A live Chopsticks-forked chain passed to a post-test script. */
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
 * Which referendum step of the run a post-test follows (1-based) and how many steps the run has,
 * plus the IDs that step executed (resolved after any creation call).
 */
export interface PostTestStepInfo {
  index: number;
  count: number;
  referendumId?: number;
  fellowshipReferendumId?: number;
}

/**
 * Context passed to a post-referendum test script. The referendum has already been executed on
 * `main`; every chain in `chains` (including `main`) is a live Chopsticks fork with the standard
 * `dev_newBlock` / `dev_setStorage` / `dev_timeTravel` RPCs available on its `wsEndpoint`. A script
 * connects with its own client (e.g. polkadot-api), builds blocks on the chains, and throws to
 * report a failure.
 */
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
 * `modulePath` is either a bundled post-test name (`apply-authorized-upgrade`, resolved inside the
 * installed package so it works under `npx`) or a path to the caller's own module, resolved against
 * the working directory. See {@link resolvePostTestModule}.
 *
 * The module is loaded with a dynamic `import()` so ESM post-tests (and the ESM-only polkadot-api
 * ecosystem they typically use) work even though this tool is CommonJS. `.js`/`.mjs`/`.cjs` load
 * directly; `.ts` relies on the host Node's type stripping (Node >= 22.18 / 23.6, or run with
 * `--experimental-strip-types`); precompile to `.js` on older runtimes. Rethrows on failure so
 * the caller can exit non-zero.
 */
export async function runPostTest(
  logger: Logger,
  modulePath: string,
  context: Omit<PostTestContext, 'args'>,
  argsRaw?: string,
  // Seam for tests: how the module URL is loaded. Production uses the real dynamic import.
  load: (specifier: string) => Promise<unknown> = dynamicImport
): Promise<void> {
  const resolved = resolvePostTestModule(modulePath);
  if (!isPathSpecifier(modulePath) && !fs.existsSync(resolved)) {
    const available = listBundledPostTests();
    throw new Error(
      `Unknown bundled post-test "${modulePath}". Available: ${available.join(', ') || '(none found)'}. ` +
        'To run your own module, pass a path instead (e.g. ./my-post-test.mjs).'
    );
  }

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

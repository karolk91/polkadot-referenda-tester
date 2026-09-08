import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  listBundledPostTests,
  type PostTestContext,
  resolvePostTestModule,
  runPostTest,
} from '../services/post-test-runner';

// Real dynamic import() has no host callback under Vitest's VM, so exercise the orchestration with
// a require-based loader (the production default is a genuine eval-based import, covered by e2e).
const requireLoad = async (specifier: string): Promise<unknown> => {
  const req = createRequire(__filename);
  return req(fileURLToPath(specifier));
};

// Minimal Logger stub (only the methods runPostTest calls).
const logger = {
  section: () => {},
  info: () => {},
  success: () => {},
} as unknown as import('../utils/logger').Logger;

const dir = mkdtempSync(join(tmpdir(), 'prt-post-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, source: string): string {
  const file = join(dir, name);
  writeFileSync(file, source);
  return file;
}

const context: PostTestContext = {
  main: {
    label: 'Main',
    specName: 'x',
    network: 'polkadot',
    kind: 'system-parachain',
    wsEndpoint: 'ws://127.0.0.1:1',
    chain: undefined,
  },
  chains: [],
  args: undefined,
  verbose: false,
  step: { index: 1, count: 1 },
};

describe('resolvePostTestModule', () => {
  const bundled = '/pkg/post-tests';

  it('resolves a bare name against the bundled post-tests directory', () => {
    expect(resolvePostTestModule('apply-authorized-upgrade', bundled)).toBe(
      join(bundled, 'apply-authorized-upgrade.mjs')
    );
  });

  it('resolves anything path-shaped against the working directory', () => {
    for (const spec of ['./mine.mjs', 'scripts/mine.mjs', 'mine.mjs', 'mine.ts', 'mine.cjs']) {
      expect(resolvePostTestModule(spec, bundled)).toBe(join(process.cwd(), spec));
    }
  });

  it('passes an absolute path through untouched', () => {
    expect(resolvePostTestModule('/tmp/mine.mjs', bundled)).toBe('/tmp/mine.mjs');
  });

  it('lists the post-tests that ship with the tool', () => {
    expect(listBundledPostTests()).toEqual(['apply-authorized-upgrade', 'dump-chain-events']);
  });
});

describe('runPostTest', () => {
  it('loads a bundled post-test by bare name', async () => {
    const seen: string[] = [];
    const load = async (specifier: string): Promise<unknown> => {
      seen.push(specifier);
      return { default: async () => {} };
    };
    await runPostTest(logger, 'apply-authorized-upgrade', context, undefined, load);
    expect(seen[0]).toMatch(/post-tests\/apply-authorized-upgrade\.mjs$/);
  });

  it('rejects an unknown bare name and lists what is available', async () => {
    await expect(runPostTest(logger, 'no-such-post-test', context)).rejects.toThrow(
      /Unknown bundled post-test "no-such-post-test"\. Available: apply-authorized-upgrade, dump-chain-events/
    );
  });

  it('runs a default-exported function and passes args (parsed as JSON)', async () => {
    const out = join(dir, 'seen-args.json');
    const mod = fixture(
      'ok.cjs',
      `module.exports.default = async (ctx) => {
         require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(ctx.args));
       };`
    );
    await runPostTest(logger, mod, context, '{"executions":2}', requireLoad);
    expect(JSON.parse(require('fs').readFileSync(out, 'utf-8'))).toEqual({ executions: 2 });
  });

  it('supports a `postTest` named export', async () => {
    const mod = fixture('named.cjs', `module.exports.postTest = async () => {};`);
    await expect(
      runPostTest(logger, mod, context, undefined, requireLoad)
    ).resolves.toBeUndefined();
  });

  it('passes the raw string when args are not JSON', async () => {
    const out = join(dir, 'raw-args.txt');
    const mod = fixture(
      'raw.cjs',
      `module.exports = async (ctx) => {
         require('fs').writeFileSync(${JSON.stringify(out)}, String(ctx.args));
       };`
    );
    await runPostTest(logger, mod, context, 'not-json', requireLoad);
    expect(require('fs').readFileSync(out, 'utf-8')).toBe('not-json');
  });

  it('propagates assertion failures from the module', async () => {
    const mod = fixture(
      'fail.cjs',
      `module.exports.default = async () => { throw new Error('boom'); };`
    );
    await expect(runPostTest(logger, mod, context, undefined, requireLoad)).rejects.toThrow('boom');
  });

  it('throws a clear error when the module exports no function', async () => {
    const mod = fixture('nofn.cjs', `module.exports = { nope: 1 };`);
    await expect(runPostTest(logger, mod, context, undefined, requireLoad)).rejects.toThrow(
      /must export a function/
    );
  });
});

import * as fs from 'fs';
import * as path from 'path';

/**
 * The post-tests that ship with the tool. `__dirname` is `<pkg>/src/utils` when running from
 * source and `<pkg>/dist/utils` when built, so one relative path finds `<pkg>/post-tests` in both
 * cases — and therefore also inside an `npx`/global install, where the caller has no idea where
 * the package lives.
 */
export const BUNDLED_POST_TESTS_DIR = path.resolve(__dirname, '../../post-tests');

/** Extensions a bundled post-test may ship with. */
const MODULE_EXTENSION = /\.[cm]?js$/;

/**
 * Bundled post-tests by name: `apply-authorized-upgrade` → `<pkg>/post-tests/…​.mjs`. A single
 * directory read backs module resolution, the `--post-test` help text and the "unknown post-test"
 * error, so they cannot disagree about what actually ships.
 */
export function bundledPostTests(dir: string = BUNDLED_POST_TESTS_DIR): Map<string, string> {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return new Map();
  }
  return new Map(
    files
      .filter((file) => MODULE_EXTENSION.test(file))
      .sort()
      .map((file) => [file.replace(MODULE_EXTENSION, ''), path.join(dir, file)])
  );
}

/** Bundled post-test names, for help and error messages. */
export function listBundledPostTests(dir?: string): string[] {
  return [...bundledPostTests(dir).keys()];
}

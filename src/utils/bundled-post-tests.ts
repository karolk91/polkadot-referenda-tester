import * as fs from 'fs';
import * as path from 'path';

/**
 * The post-tests included with the tool. `__dirname` is `<pkg>/src/utils` when running from
 * source and `<pkg>/dist/utils` when built, so one relative path resolves to `<pkg>/post-tests` in
 * both cases, including an `npx` or global install where the caller does not know the package
 * location.
 */
export const BUNDLED_POST_TESTS_DIR = path.resolve(__dirname, '../../post-tests');

/** Extensions a bundled post-test may use. */
const MODULE_EXTENSION = /\.[cm]?js$/;

/**
 * Bundled post-tests by name: `apply-authorized-upgrade` → `<pkg>/post-tests/…​.mjs`. One
 * directory read provides module resolution, the `--post-test` help text and the "unknown
 * post-test" error, so all three report the same set of files.
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

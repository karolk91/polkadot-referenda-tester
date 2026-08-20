import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

/**
 * Parsed chain endpoint with optional block number and optional chopsticks-config
 * extras pulled from a YAML file (`wasm-override`, `import-storage`, `runtime-log-level`, …).
 * The tool merges `baseConfig` into the chopsticks per-chain config, then overlays
 * its mandatory test-harness settings on top.
 */
export interface ParsedEndpoint {
  url: string;
  block?: number;
  /**
   * Extra chopsticks config keys parsed from a YAML file when the user passes a path
   * (instead of a URL) to a `--*-url` flag. Always omits `endpoint` and `block`
   * (those become `url` / `block` on this struct).
   */
  baseConfig?: Record<string, unknown>;
}

export type UrlNetworkHint = 'polkadot' | 'kusama' | 'paseo' | 'westend' | 'rococo' | 'unknown';

/**
 * Best-effort network inference from an RPC URL substring. Used at CLI parse time
 * before any chain connection exists. Not a substitute for `chain-registry`'s
 * runtime-metadata-based identification, but enough to route the bridged scenario.
 */
export function inferNetworkFromUrl(url: string): UrlNetworkHint {
  // Check more-specific networks before "polkadot" because public-RPC endpoints
  // for Kusama/Westend/etc. are commonly hosted under *.polkadot.io
  // (e.g. wss://kusama-asset-hub-rpc.polkadot.io) — the substring "polkadot"
  // would otherwise outrank the actually-correct network token in the subdomain.
  const lower = url.toLowerCase();
  if (lower.includes('kusama')) return 'kusama';
  if (lower.includes('paseo')) return 'paseo';
  if (lower.includes('westend')) return 'westend';
  if (lower.includes('rococo')) return 'rococo';
  if (lower.includes('polkadot')) return 'polkadot';
  return 'unknown';
}

/**
 * Parse a chain endpoint string that may include a block number.
 *
 * Formats supported:
 * - "wss://polkadot.io" -> { url: "wss://polkadot.io" }
 * - "wss://polkadot.io,12345" -> { url: "wss://polkadot.io", block: 12345 }
 *
 * @param input - The input string in format "url" or "url,block"
 * @returns Parsed endpoint with url and optional block number
 * @throws Error if the format is invalid or block number is not a valid integer
 */
export function parseEndpoint(input: string): ParsedEndpoint {
  if (!input || input.trim().length === 0) {
    throw new Error('Endpoint string cannot be empty');
  }

  // If the value doesn't contain `://`, treat it as a path to a chopsticks YAML
  // config file. Reading the file lets users bake in `wasm-override`, custom
  // `import-storage`, fork block, etc. — without changing the tool.
  const trimmed = input.trim();
  if (!trimmed.includes('://')) {
    return parseChopsticksConfigFile(trimmed);
  }

  const parts = input.split(',');

  if (parts.length === 1) {
    return { url: parts[0].trim() };
  }

  if (parts.length === 2) {
    const url = parts[0].trim();
    const blockStr = parts[1].trim();

    const blockNum = parseInt(blockStr, 10);
    if (Number.isNaN(blockNum) || blockNum < 0) {
      throw new Error(`Invalid block number: ${blockStr}. Must be a non-negative integer.`);
    }

    return { url, block: blockNum };
  }

  throw new Error(`Invalid endpoint format: ${input}. Expected "url" or "url,block"`);
}

/**
 * Load a chopsticks YAML config file and return its endpoint+block+extras. The file's
 * `endpoint` becomes `url`, its optional `block` becomes `block`, and everything else
 * lands in `baseConfig` for the topology builder to merge.
 */
function parseChopsticksConfigFile(filePath: string): ParsedEndpoint {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Endpoint "${filePath}" looks like a path but the file does not exist (resolved to ${resolved}). Pass either a wss:// URL or a readable chopsticks YAML config file.`
    );
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = yaml.load(raw) as Record<string, unknown> | undefined | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Chopsticks config at ${resolved} did not yield a YAML object`);
  }
  const endpoint = parsed.endpoint;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('ws')) {
    throw new Error(
      `Chopsticks config at ${resolved} is missing a string "endpoint:" field (must be a wss:// or ws:// URL)`
    );
  }
  let block: number | undefined;
  if (parsed.block !== undefined) {
    if (typeof parsed.block !== 'number' || !Number.isFinite(parsed.block) || parsed.block < 0) {
      throw new Error(
        `Chopsticks config at ${resolved}: "block:" must be a non-negative integer when present`
      );
    }
    block = parsed.block;
  }
  // Strip `endpoint`/`block` since we surface them as `url`/`block` instead. Everything
  // else (wasm-override, import-storage, runtime-log-level, …) flows through as
  // `baseConfig` for the topology builder.
  const { endpoint: _ep, block: _b, ...rest } = parsed;
  void _ep;
  void _b;
  return { url: endpoint, block, baseConfig: rest };
}

/**
 * Parse multiple chain endpoints from a comma-separated string.
 * Each endpoint can optionally include a block number.
 *
 * Examples:
 * - "wss://chain1.io,wss://chain2.io"
 * - "wss://chain1.io,12345,wss://chain2.io"
 * - "wss://chain1.io,12345,wss://chain2.io,67890"
 *
 * @param input - Comma-separated string of endpoints
 * @returns Array of parsed endpoints
 */
export function parseMultipleEndpoints(input: string): ParsedEndpoint[] {
  if (!input || input.trim().length === 0) {
    return [];
  }

  const endpoints: ParsedEndpoint[] = [];
  const parts = input.split(',').map((p) => p.trim());

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];

    if (part.includes('://')) {
      // URL form, optionally followed by a block number in the next slot.
      if (
        i + 1 < parts.length &&
        !parts[i + 1].includes('://') &&
        !looksLikeFilePath(parts[i + 1])
      ) {
        const blockNum = parseInt(parts[i + 1], 10);
        if (!Number.isNaN(blockNum) && blockNum >= 0) {
          endpoints.push({ url: part, block: blockNum });
          i += 2;
          continue;
        }
      }
      endpoints.push({ url: part });
      i += 1;
    } else if (looksLikeFilePath(part)) {
      // Path to a chopsticks YAML config file — load it.
      endpoints.push(parseChopsticksConfigFile(part));
      i += 1;
    } else {
      throw new Error(`Expected URL or config-file path at position ${i}, got: ${part}`);
    }
  }

  return endpoints;
}

/**
 * Heuristic: a comma-separated entry is treated as a file path when it doesn't look
 * like a number and doesn't contain `://`. Used to disambiguate "URL,block,URL" from
 * "URL,/path/to.yml,URL" in `--additional-chains`.
 */
function looksLikeFilePath(token: string): boolean {
  if (token.includes('://')) return false;
  return !/^[0-9]+$/.test(token);
}

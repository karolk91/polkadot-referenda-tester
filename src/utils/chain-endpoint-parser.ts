/**
 * Parsed chain endpoint with optional block number
 */
export interface ParsedEndpoint {
  url: string;
  block?: number;
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

  const parts = input.split(',');

  if (parts.length === 1) {
    // Just URL, no block number
    return { url: parts[0].trim() };
  }

  if (parts.length === 2) {
    const url = parts[0].trim();
    const blockStr = parts[1].trim();

    const blockNum = parseInt(blockStr, 10);
    if (isNaN(blockNum) || blockNum < 0) {
      throw new Error(`Invalid block number: ${blockStr}. Must be a non-negative integer.`);
    }

    return { url, block: blockNum };
  }

  // More than one comma - this is an error for a single endpoint
  throw new Error(`Invalid endpoint format: ${input}. Expected "url" or "url,block"`);
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

    // Check if this looks like a URL (contains ://)
    if (part.includes('://')) {
      // Check if next part is a block number
      if (i + 1 < parts.length && !parts[i + 1].includes('://')) {
        const blockNum = parseInt(parts[i + 1], 10);
        if (!isNaN(blockNum) && blockNum >= 0) {
          endpoints.push({ url: part, block: blockNum });
          i += 2; // Skip both URL and block
          continue;
        }
      }

      // Just URL without block
      endpoints.push({ url: part });
      i += 1;
    } else {
      throw new Error(`Expected URL at position ${i}, got: ${part}`);
    }
  }

  return endpoints;
}

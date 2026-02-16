/**
 * JSON utilities for handling BigInt serialization
 */

/**
 * Serialize any value to JSON string, handling BigInt values
 */
export function stringify(value: any, space?: number): string {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), space);
}

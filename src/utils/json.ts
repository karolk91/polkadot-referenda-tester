/**
 * JSON utilities for handling BigInt serialization
 */

/**
 * Serialize any value to JSON string, handling BigInt values
 */
export function stringify(value: any, space?: number): string {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), space);
}

/**
 * Enable global BigInt serialization for JSON.stringify
 * This patches BigInt.prototype.toJSON
 */
export function enableBigIntSerialization(): void {
  // @ts-expect-error - Adding toJSON to BigInt prototype
  BigInt.prototype.toJSON = function () {
    return this.toString();
  };
}

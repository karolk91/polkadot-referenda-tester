import { toHexString } from './hex';

/**
 * Convert polkadot-api origin format to Chopsticks storage format (lowercase enum variant).
 *
 * polkadot-api: { type: "Origins", value: { type: "Treasurer" } }
 * Chopsticks:   { origins: "Treasurer" }
 */
export function convertOriginToStorageFormat(origin: unknown): unknown {
  if (!origin || typeof origin !== 'object') {
    return origin;
  }

  const originRecord = origin as Record<string, unknown>;

  if ('type' in originRecord && 'value' in originRecord) {
    const outerVariant = (originRecord.type as string).toLowerCase();
    const innerValue = originRecord.value;

    if (innerValue && typeof innerValue === 'object' && 'type' in innerValue) {
      return {
        [outerVariant]: (innerValue as Record<string, unknown>).type,
      };
    }

    return {
      [outerVariant]: innerValue,
    };
  }

  return origin;
}

/**
 * Convert polkadot-api proposal format to Chopsticks storage format.
 *
 * Handles both Lookup and Inline proposal types.
 */
export function convertProposalToStorageFormat(proposal: unknown): unknown {
  return convertCallToStorageFormat(proposal);
}

/**
 * Convert agenda items from polkadot-api format to Chopsticks storage format.
 */
export function convertAgendaToStorageFormat(agendaItems: unknown[]): unknown[] {
  if (!Array.isArray(agendaItems)) {
    return agendaItems;
  }

  return agendaItems.map((item: unknown) => {
    if (!item || typeof item !== 'object') return item;

    const entry = item as Record<string, unknown>;
    const converted: Record<string, unknown> = {};

    if (entry.call) {
      converted.call = convertCallToStorageFormat(entry.call);
    }

    if (entry.maybeId !== undefined) converted.maybeId = entry.maybeId;
    if (entry.priority !== undefined) converted.priority = entry.priority;
    if (entry.maybePeriodic !== undefined) converted.maybePeriodic = entry.maybePeriodic;
    if (entry.origin !== undefined) {
      converted.origin = convertOriginToStorageFormat(entry.origin);
    }

    return converted;
  });
}

/**
 * Convert call enum (Inline/Lookup/Legacy) to Chopsticks storage format.
 */
export function convertCallToStorageFormat(call: unknown): unknown {
  if (!call || typeof call !== 'object') {
    return call;
  }

  const callRecord = call as Record<string, unknown>;

  if ('type' in callRecord && 'value' in callRecord) {
    const callType = (callRecord.type as string).toLowerCase();

    if (callType === 'inline') {
      return {
        inline: toHexString(callRecord.value) ?? callRecord.value,
      };
    } else if (callType === 'lookup') {
      const value = callRecord.value as Record<string, unknown>;
      return {
        lookup: {
          hash: toHexString(value.hash) ?? value.hash,
          len: value.len,
        },
      };
    } else if (callType === 'legacy') {
      return {
        legacy: callRecord.value,
      };
    }

    return {
      [callType]: callRecord.value,
    };
  }

  return call;
}

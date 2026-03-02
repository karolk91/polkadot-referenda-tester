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

  const o = origin as Record<string, unknown>;

  if ('type' in o && 'value' in o) {
    const outerVariant = (o.type as string).toLowerCase();
    const innerValue = o.value;

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
  if (!proposal || typeof proposal !== 'object') {
    return proposal;
  }

  const p = proposal as Record<string, unknown>;

  if ('type' in p && 'value' in p) {
    const proposalType = (p.type as string).toLowerCase();

    if (proposalType === 'lookup') {
      const value = p.value as Record<string, unknown>;
      return {
        lookup: {
          hash: toHexString(value.hash) ?? value.hash,
          len: value.len,
        },
      };
    } else if (proposalType === 'inline') {
      return {
        inline: toHexString(p.value) ?? p.value,
      };
    }

    return {
      [proposalType]: p.value,
    };
  }

  return proposal;
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

  const c = call as Record<string, unknown>;

  if ('type' in c && 'value' in c) {
    const callType = (c.type as string).toLowerCase();

    if (callType === 'inline') {
      return {
        inline: toHexString(c.value) ?? c.value,
      };
    } else if (callType === 'lookup') {
      const value = c.value as Record<string, unknown>;
      return {
        lookup: {
          hash: toHexString(value.hash) ?? value.hash,
          len: value.len,
        },
      };
    } else if (callType === 'legacy') {
      return {
        legacy: c.value,
      };
    }

    return {
      [callType]: c.value,
    };
  }

  return call;
}

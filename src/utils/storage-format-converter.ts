/**
 * Convert polkadot-api origin format to Chopsticks storage format (lowercase enum variant).
 *
 * polkadot-api: { type: "Origins", value: { type: "Treasurer" } }
 * Chopsticks:   { origins: "Treasurer" }
 */
export function convertOriginToStorageFormat(origin: any): any {
  if (!origin || typeof origin !== 'object') {
    return origin;
  }

  if ('type' in origin && 'value' in origin) {
    const outerVariant = origin.type.toLowerCase();
    const innerValue = origin.value;

    if (innerValue && typeof innerValue === 'object' && 'type' in innerValue) {
      return {
        [outerVariant]: innerValue.type,
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
export function convertProposalToStorageFormat(proposal: any): any {
  if (!proposal || typeof proposal !== 'object') {
    return proposal;
  }

  if ('type' in proposal && 'value' in proposal) {
    const proposalType = proposal.type.toLowerCase();

    if (proposalType === 'lookup') {
      let hashValue = proposal.value.hash;
      if (hashValue && typeof hashValue === 'object' && 'asHex' in hashValue) {
        hashValue = hashValue.asHex();
      }

      return {
        lookup: {
          hash: hashValue,
          len: proposal.value.len,
        },
      };
    } else if (proposalType === 'inline') {
      let inlineValue = proposal.value;
      if (inlineValue && typeof inlineValue === 'object' && 'asHex' in inlineValue) {
        inlineValue = inlineValue.asHex();
      }

      return {
        inline: inlineValue,
      };
    }

    return {
      [proposalType]: proposal.value,
    };
  }

  return proposal;
}

/**
 * Convert agenda items from polkadot-api format to Chopsticks storage format.
 */
export function convertAgendaToStorageFormat(agendaItems: any[]): any[] {
  if (!Array.isArray(agendaItems)) {
    return agendaItems;
  }

  return agendaItems.map((item) => {
    if (!item) return item;

    const converted: any = {};

    if (item.call) {
      converted.call = convertCallToStorageFormat(item.call);
    }

    if (item.maybeId !== undefined) converted.maybeId = item.maybeId;
    if (item.priority !== undefined) converted.priority = item.priority;
    if (item.maybePeriodic !== undefined) converted.maybePeriodic = item.maybePeriodic;
    if (item.origin !== undefined) {
      converted.origin = convertOriginToStorageFormat(item.origin);
    }

    return converted;
  });
}

/**
 * Convert call enum (Inline/Lookup/Legacy) to Chopsticks storage format.
 */
export function convertCallToStorageFormat(call: any): any {
  if (!call || typeof call !== 'object') {
    return call;
  }

  if ('type' in call && 'value' in call) {
    const callType = call.type.toLowerCase();

    if (callType === 'inline') {
      let inlineValue = call.value;
      if (inlineValue && typeof inlineValue === 'object') {
        if ('asHex' in inlineValue && typeof inlineValue.asHex === 'function') {
          inlineValue = inlineValue.asHex();
        } else if ('toHex' in inlineValue && typeof inlineValue.toHex === 'function') {
          inlineValue = inlineValue.toHex();
        }
      }
      return {
        inline: inlineValue,
      };
    } else if (callType === 'lookup') {
      let hashValue = call.value.hash;
      if (hashValue && typeof hashValue === 'object') {
        if ('asHex' in hashValue && typeof hashValue.asHex === 'function') {
          hashValue = hashValue.asHex();
        } else if ('toHex' in hashValue && typeof hashValue.toHex === 'function') {
          hashValue = hashValue.toHex();
        }
      }
      return {
        lookup: {
          hash: hashValue,
          len: call.value.len,
        },
      };
    } else if (callType === 'legacy') {
      return {
        legacy: call.value,
      };
    }

    return {
      [callType]: call.value,
    };
  }

  return call;
}

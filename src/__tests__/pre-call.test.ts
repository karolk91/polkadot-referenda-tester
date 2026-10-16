import { describe, expect, it } from 'vitest';
import { parseOriginString } from '../referendum/pre-call';
import { createTestLogger } from './helpers';

describe('parseOriginString', () => {
  it.each([
    ['Root', { System: 'Root' }],
    ['Origins.Treasurer', { Origins: 'Treasurer' }],
    ['Council.Members', { Council: 'Members' }],
    ['WhitelistedCaller', { Origins: 'WhitelistedCaller' }],
    ['WishForChange', { Origins: 'WishForChange' }],
  ])('origin of %s', (originString, expected) => {
    expect(parseOriginString(originString, createTestLogger())).toEqual(expected);
  });

  it('System origin with a warning for an unknown name', () => {
    const logger = createTestLogger();
    expect(parseOriginString('NonExistentOrigin', logger)).toEqual({ System: 'NonExistentOrigin' });
    expect(logger.warn, 'the integration tests rely on this warning').toHaveBeenCalledWith(
      expect.stringContaining('Unknown origin format')
    );
  });
});

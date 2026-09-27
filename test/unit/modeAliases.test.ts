import { describe, expect, it } from 'vitest';
import { readModeAliases } from '../../packages/shared-domain/src/settings/modeAliases';

describe('readModeAliases', () => {
  it('normalizes alias keys and ignores malformed entries', () => {
    expect(readModeAliases({ Home: 'Comfort', invalid: 3 })).toEqual({ home: 'Comfort' });
  });

  it('rejects values that are not a catalog record', () => {
    expect(readModeAliases(null)).toBeNull();
    expect(readModeAliases(['Home', 'Away'])).toBeNull();
  });
});

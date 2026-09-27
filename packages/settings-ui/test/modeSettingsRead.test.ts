import { describe, expect, it } from 'vitest';
import { readModeAliases } from '../src/ui/modeSettingsRead.ts';

describe('settings UI mode alias reads', () => {
  it('uses the shared lowercase and malformed-entry policy', () => {
    expect(readModeAliases({ Home: 'Comfort', invalid: false })).toEqual({ home: 'Comfort' });
    expect(readModeAliases(null)).toBeNull();
  });
});

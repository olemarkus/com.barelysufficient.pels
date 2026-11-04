import { describe, expect, it } from 'vitest';
import { isCommandableNow, resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';

const EV = { isEvCharger: true, available: true };

describe('resolveCommandableNow', () => {
  it('is a boolean over two observed facts — plug-state and availability', () => {
    expect(resolveCommandableNow({ ...EV, evChargingState: 'plugged_in_charging' })).toBe(true);
    expect(resolveCommandableNow({ ...EV, evChargingState: 'plugged_out' })).toBe(false);
    expect(resolveCommandableNow({ ...EV, evChargingState: 'plugged_in_paused', available: false })).toBe(false);
    expect(resolveCommandableNow({ isEvCharger: false, available: true })).toBe(true);
    expect(resolveCommandableNow({ isEvCharger: false, available: false })).toBe(false);
  });

  it('asks the plug-state question only of EV devices', () => {
    // A non-EV device needs no plug-state observation to be commandable.
    expect(resolveCommandableNow({ isEvCharger: false, available: true })).toBe(true);
  });

  it('keeps an EV with no accepted plug-state from starting', () => {
    // Independent observations stay visible, but no session fact is invented.
    expect(resolveCommandableNow(EV)).toBe(false);
  });
});

describe('isCommandableNow', () => {
  it('reads the producer-resolved bit and nothing else', () => {
    expect(isCommandableNow({ commandableNow: false })).toBe(false);
    expect(isCommandableNow({ commandableNow: true })).toBe(true);
  });

  it('ignores raw fields sitting alongside the bit', () => {
    // The dual-read is deleted: raw fields must not change the answer. That
    // fallback is what made every plan device read "charger state unknown" once
    // the since-deleted `withEvDiscriminant` stripped the plug-state — it saw absence and answered.
    const withRawFields = {
      commandableNow: true,
      available: false,
      evChargingState: 'plugged_out',
    } as unknown as Parameters<typeof isCommandableNow>[0];
    expect(isCommandableNow(withRawFields)).toBe(true);
  });
});

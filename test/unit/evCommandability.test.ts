import { describe, expect, it } from 'vitest';
import { isCommandableNow, resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';

const EV = { deviceClass: 'evcharger' as const, available: true };

describe('resolveCommandableNow', () => {
  it('is a boolean over two observed facts — plug-state and availability', () => {
    expect(resolveCommandableNow({ ...EV, evChargingState: 'plugged_in_charging' })).toBe(true);
    expect(resolveCommandableNow({ ...EV, evChargingState: 'plugged_out' })).toBe(false);
    expect(resolveCommandableNow({ ...EV, evChargingState: 'plugged_in_paused', available: false })).toBe(false);
    expect(resolveCommandableNow({ deviceClass: 'thermostat', available: true })).toBe(true);
    expect(resolveCommandableNow({ deviceClass: 'thermostat', available: false })).toBe(false);
  });

  it('asks the plug-state question only of EV devices', () => {
    // A non-EV device carries no plug-state at all — absence here means exactly
    // "not an EV charger", never "an EV charger we could not read".
    expect(resolveCommandableNow({ deviceClass: 'thermostat', available: true })).toBe(true);
  });

  it('leaves an EV device with no plug-state commandable', () => {
    // Invariant-impossible: such a charger is dropped at the parse boundary. If
    // one ever reached here it reads as commandable, which is the safe direction —
    // refusing to command is a one-way door, since shed selection does not consult
    // commandability while both restore paths do.
    expect(resolveCommandableNow(EV)).toBe(true);
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

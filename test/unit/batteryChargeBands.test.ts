// The charge ceiling the verification ledger learns per charge band
// (`lib/battery/batteryVerification.ts`): a charge that stops short near full
// caps only its band and those above it; below 80 %, or at an unreported
// level, it caps every level.
import { describe, expect, it } from 'vitest';
import {
  BatteryVerificationLedger,
  chargeCeilingAtLevelW,
  DELIVERY_CEILING_TTL_MS,
} from '../../lib/battery/batteryVerification';
import type { HomeBatterySetpointRange } from '../../packages/contracts/src/types';

const BATTERY = 'battery';
const RANGE: HomeBatterySetpointRange = { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 };
const level = (percent: number) => ({ percent, observedAtMs: 0 });

describe('battery charge ceiling by charge band', () => {
  it('places a lesson near full in its 5 % band and one below 80 % at every level', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 1800, level(60), 0);
    ledger.recordChargeCeiling(BATTERY, 1200, level(87), 0);
    ledger.recordChargeCeiling(BATTERY, 0, level(100), 0);

    expect(ledger.read(BATTERY, RANGE, 0).chargeCeiling).toEqual({
      everyLevelW: 1800,
      taper: [{ fromPercent: 85, ceilingW: 1200 }, { fromPercent: 95, ceilingW: 0 }],
    });
  });

  it('keeps the old every-level lesson when the battery reports no level', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 900, undefined, 0);
    expect(ledger.read(BATTERY, RANGE, 0).chargeCeiling).toEqual({ everyLevelW: 900, taper: [] });
  });

  it('resolves the ceiling at a level from every step at or below it', () => {
    const ceiling = { everyLevelW: 2500, taper: [{ fromPercent: 85, ceilingW: 1200 }, { fromPercent: 95, ceilingW: 1500 }] };
    expect(chargeCeilingAtLevelW(ceiling, level(84))).toBe(2500);
    expect(chargeCeilingAtLevelW(ceiling, level(85))).toBe(1200);
    // A higher band's lesson cannot lift a lower one's: the taper only falls.
    expect(chargeCeilingAtLevelW(ceiling, level(97))).toBe(1200);
    expect(chargeCeilingAtLevelW(ceiling, undefined)).toBe(2500);
  });

  it('expires each band on its own clock', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 1000, level(82), 0);
    ledger.recordChargeCeiling(BATTERY, 400, level(96), DELIVERY_CEILING_TTL_MS / 2);

    expect(ledger.read(BATTERY, RANGE, DELIVERY_CEILING_TTL_MS).chargeCeiling)
      .toEqual({ everyLevelW: 2500, taper: [{ fromPercent: 95, ceilingW: 400 }] });
  });

  it('lifts only the bands a charge at a known level shows to be too low', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 1000, level(82), 0);
    ledger.recordChargeCeiling(BATTERY, 300, level(96), 0);

    ledger.recordResponding(BATTERY, { signedW: 2000, toleranceW: 50, level: level(88) }, 1000);
    expect(ledger.read(BATTERY, RANGE, 1000).chargeCeiling)
      .toEqual({ everyLevelW: 2500, taper: [{ fromPercent: 95, ceilingW: 300 }] });
  });

  it('lifts only the every-level lesson from a charge at an unreported level', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 1000, level(50), 0);
    ledger.recordChargeCeiling(BATTERY, 300, level(96), 0);

    ledger.recordResponding(BATTERY, { signedW: 2000, toleranceW: 50, level: undefined }, 1000);
    expect(ledger.read(BATTERY, RANGE, 1000).chargeCeiling)
      .toEqual({ everyLevelW: 2500, taper: [{ fromPercent: 95, ceilingW: 300 }] });
  });

  it('forgets every band once the battery is sign-inverted', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 300, level(96), 0);
    ledger.recordSignInverted(BATTERY);
    expect(ledger.read(BATTERY, RANGE, 0).chargeCeiling).toEqual({ everyLevelW: 2500, taper: [] });
  });
});

// The charge ceiling the verification ledger learns per charge band
// (`lib/battery/batteryVerification.ts`): a charge that stops short near full
// caps only its band and those above it; below 80 %, or at an unreported
// level, it caps every level. Live control holds a band lesson for 30 min;
// the plan keeps it for a week until it is re-taught or lifted.
import { describe, expect, it } from 'vitest';
import {
  BatteryVerificationLedger,
  CHARGE_TAPER_PLANNING_RETENTION_MS,
  chargeCeilingAtLevelW,
  DELIVERY_CEILING_TTL_MS,
} from '../../lib/battery/batteryVerification';
import type { HomeBatterySetpointRange } from '../../packages/contracts/src/types';

const BATTERY = 'battery';
const RANGE: HomeBatterySetpointRange = { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 };
const level = (percent: number) => ({ percent, observedAtMs: 0 });
const ceilingAt = (ledger: BatteryVerificationLedger, nowMs: number) => ledger.read(BATTERY, RANGE, nowMs).chargeCeiling;

describe('battery charge ceiling by charge band', () => {
  it('places a lesson near full in its 5 % band and one below 80 % at every level', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 1800, level(60), 0);
    ledger.recordChargeCeiling(BATTERY, 1200, level(87), 0);
    ledger.recordChargeCeiling(BATTERY, 0, level(100), 0);

    const taper = [{ fromPercent: 85, ceilingW: 1200 }, { fromPercent: 95, ceilingW: 0 }];
    expect(ceilingAt(ledger, 0)).toEqual({ everyLevelW: 1800, taper, planningTaper: taper });
  });

  it('keeps the old every-level lesson when the battery reports no level', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 900, undefined, 0);
    expect(ceilingAt(ledger, 0)).toEqual({ everyLevelW: 900, taper: [], planningTaper: [] });
  });

  it('resolves the ceiling at a level from every step at or below it', () => {
    const ceiling = {
      everyLevelW: 2500,
      taper: [{ fromPercent: 85, ceilingW: 1200 }, { fromPercent: 95, ceilingW: 1500 }],
      planningTaper: [],
    };
    expect(chargeCeilingAtLevelW(ceiling, level(84))).toBe(2500);
    expect(chargeCeilingAtLevelW(ceiling, level(85))).toBe(1200);
    // A higher band's lesson cannot lift a lower one's: the taper only falls.
    expect(chargeCeilingAtLevelW(ceiling, level(97))).toBe(1200);
    expect(chargeCeilingAtLevelW(ceiling, undefined)).toBe(2500);
  });

  it('lets live control ask full power again after 30 min while the plan keeps the taper', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 1000, level(82), 0);
    ledger.recordChargeCeiling(BATTERY, 400, level(96), DELIVERY_CEILING_TTL_MS / 2);

    expect(ceilingAt(ledger, DELIVERY_CEILING_TTL_MS)).toEqual({
      everyLevelW: 2500,
      taper: [{ fromPercent: 95, ceilingW: 400 }],
      planningTaper: [{ fromPercent: 80, ceilingW: 1000 }, { fromPercent: 95, ceilingW: 400 }],
    });
    expect(ceilingAt(ledger, 2 * DELIVERY_CEILING_TTL_MS).planningTaper).toHaveLength(2);
    expect(ceilingAt(ledger, CHARGE_TAPER_PLANNING_RETENTION_MS).planningTaper)
      .toEqual([{ fromPercent: 95, ceilingW: 400 }]);
  });

  it('replaces a band lesson when the band is taught again', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 1000, level(91), 0);
    ledger.recordChargeCeiling(BATTERY, 1300, level(93), 2 * DELIVERY_CEILING_TTL_MS);
    expect(ceilingAt(ledger, 2 * DELIVERY_CEILING_TTL_MS).planningTaper).toEqual([{ fromPercent: 90, ceilingW: 1300 }]);
  });

  it('lifts a band from both live control and the plan once a charge passes it, even after live expiry', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 1000, level(82), 0);
    ledger.recordChargeCeiling(BATTERY, 300, level(96), 0);

    const laterMs = 2 * DELIVERY_CEILING_TTL_MS;
    ledger.recordResponding(BATTERY, { signedW: 2000, toleranceW: 50, level: level(88) }, laterMs);
    expect(ceilingAt(ledger, laterMs))
      .toEqual({ everyLevelW: 2500, taper: [], planningTaper: [{ fromPercent: 95, ceilingW: 300 }] });

    ledger.recordChargeCeiling(BATTERY, 700, level(86), laterMs);
    ledger.recordResponding(BATTERY, { signedW: 2000, toleranceW: 50, level: level(87) }, laterMs + 1000);
    expect(ceilingAt(ledger, laterMs + 1000))
      .toEqual({ everyLevelW: 2500, taper: [], planningTaper: [{ fromPercent: 95, ceilingW: 300 }] });
  });

  it('lifts only the every-level lesson from a charge at an unreported level', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 1000, level(50), 0);
    ledger.recordChargeCeiling(BATTERY, 300, level(96), 0);

    ledger.recordResponding(BATTERY, { signedW: 2000, toleranceW: 50, level: undefined }, 1000);
    const taper = [{ fromPercent: 95, ceilingW: 300 }];
    expect(ceilingAt(ledger, 1000)).toEqual({ everyLevelW: 2500, taper, planningTaper: taper });
  });

  it('forgets every band once the battery is sign-inverted', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, 300, level(96), 0);
    ledger.recordSignInverted(BATTERY);
    expect(ceilingAt(ledger, 0)).toEqual({ everyLevelW: 2500, taper: [], planningTaper: [] });
  });
});

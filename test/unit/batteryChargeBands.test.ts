// The charge ceiling the verification ledger learns per charge band
// (`lib/battery/batteryVerification.ts`): a charge that stops short near full
// caps only its band and those above it; below 80 %, or at an unreported
// level, it caps every level. Live control holds a band lesson for 30 min;
// the plan keeps a taper a second plateau confirmed for a week until it is
// re-taught or lifted, and never keeps a stop (no charge taken at all).
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
const TOLERANCE_W = 150;
const charged = (signedW: number, at: ReturnType<typeof level> | undefined) => (
  { signedW, toleranceW: TOLERANCE_W, level: at }
);
const ceilingAt = (ledger: BatteryVerificationLedger, nowMs: number) => ledger.read(BATTERY, RANGE, nowMs).chargeCeiling;
/** A band plateau taught twice, the second at `atMs`: the confirmation the plan keeps a taper on. */
const teachTwice = (
  ledger: BatteryVerificationLedger, signedW: number, at: ReturnType<typeof level>, atMs: number,
) => {
  ledger.recordChargeCeiling(BATTERY, charged(signedW, at), atMs - 1);
  ledger.recordChargeCeiling(BATTERY, charged(signedW, at), atMs);
};

describe('battery charge ceiling by charge band', () => {
  it('places a lesson near full in its 5 % band and one below 80 % at every level', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, charged(1800, level(60)), 0);
    teachTwice(ledger, 1200, level(87), 0);
    ledger.recordChargeCeiling(BATTERY, charged(0, level(100)), 0);

    expect(ceilingAt(ledger, 0)).toEqual({
      everyLevelW: 1800,
      taper: [{ fromPercent: 85, ceilingW: 1200 }, { fromPercent: 95, ceilingW: 0 }],
      planningTaper: [{ fromPercent: 85, ceilingW: 1200 }],
    });
  });

  // A plateau is judged on one fresh reading 90 s after the step: a battery
  // that ramps slower stops "short" once, and the plan must not cap charge
  // from that band up for a week on it (nothing would lift it, since live
  // control asks for no more than the plan does).
  it('keeps a band lesson for the plan only once a second plateau confirms it', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, charged(1000, level(82)), 0);
    expect(ceilingAt(ledger, 0)).toEqual({
      everyLevelW: 2500, taper: [{ fromPercent: 80, ceilingW: 1000 }], planningTaper: [],
    });
    expect(ceilingAt(ledger, DELIVERY_CEILING_TTL_MS)).toEqual({ everyLevelW: 2500, taper: [], planningTaper: [] });

    // Asked for full power again, it ramped past the first plateau but still stopped short:
    // a new first lesson, not a confirmation.
    ledger.recordChargeCeiling(BATTERY, charged(1600, level(83)), DELIVERY_CEILING_TTL_MS);
    expect(ceilingAt(ledger, DELIVERY_CEILING_TTL_MS).planningTaper).toEqual([]);

    // The same plateau again, within the tolerance: the band's taper is confirmed.
    ledger.recordChargeCeiling(BATTERY, charged(1600 + TOLERANCE_W, level(84)), 2 * DELIVERY_CEILING_TTL_MS);
    expect(ceilingAt(ledger, 2 * DELIVERY_CEILING_TTL_MS).planningTaper)
      .toEqual([{ fromPercent: 80, ceilingW: 1600 + TOLERANCE_W }]);
  });

  it('lifts a lesson still awaiting its confirmation once a charge passes it', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, charged(1000, level(91)), 0);
    const laterMs = 2 * DELIVERY_CEILING_TTL_MS;
    ledger.recordResponding(BATTERY, { signedW: 2000, toleranceW: TOLERANCE_W, level: level(92) }, laterMs);
    // The passed plateau confirms nothing: the next one is a first lesson again.
    ledger.recordChargeCeiling(BATTERY, charged(1000, level(93)), laterMs + 1000);
    expect(ceilingAt(ledger, laterMs + 1000).planningTaper).toEqual([]);
  });

  it('keeps a full battery\'s stop for live control only, so the plan can still charge near full', () => {
    const ledger = new BatteryVerificationLedger();
    // Full, or at its own charge limit: it took no charge, within the tolerance (inclusive).
    ledger.recordChargeCeiling(BATTERY, charged(TOLERANCE_W, level(97)), 0);

    expect(ceilingAt(ledger, 0)).toEqual({
      everyLevelW: 2500, taper: [{ fromPercent: 95, ceilingW: TOLERANCE_W }], planningTaper: [],
    });
    expect(ceilingAt(ledger, DELIVERY_CEILING_TTL_MS)).toEqual({ everyLevelW: 2500, taper: [], planningTaper: [] });
  });

  it('lifts a held stop once a charge at that level passes it', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, charged(0, level(96)), 0);
    ledger.recordResponding(BATTERY, { signedW: 1000, toleranceW: TOLERANCE_W, level: level(96) }, 1000);
    expect(ceilingAt(ledger, 1000).taper).toEqual([]);
  });

  it('keeps the old every-level lesson when the battery reports no level', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, charged(900, undefined), 0);
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
    teachTwice(ledger, 1000, level(82), 0);
    teachTwice(ledger, 400, level(96), DELIVERY_CEILING_TTL_MS / 2);

    expect(ceilingAt(ledger, DELIVERY_CEILING_TTL_MS)).toEqual({
      everyLevelW: 2500,
      taper: [{ fromPercent: 95, ceilingW: 400 }],
      planningTaper: [{ fromPercent: 80, ceilingW: 1000 }, { fromPercent: 95, ceilingW: 400 }],
    });
    expect(ceilingAt(ledger, 2 * DELIVERY_CEILING_TTL_MS).planningTaper).toHaveLength(2);
    expect(ceilingAt(ledger, CHARGE_TAPER_PLANNING_RETENTION_MS).planningTaper)
      .toEqual([{ fromPercent: 95, ceilingW: 400 }]);
  });

  it('re-teaches a confirmed band with a plateau that repeats it within the tolerance', () => {
    const ledger = new BatteryVerificationLedger();
    teachTwice(ledger, 1000, level(91), 0);
    ledger.recordChargeCeiling(BATTERY, charged(900, level(93)), 2 * DELIVERY_CEILING_TTL_MS);
    expect(ceilingAt(ledger, 2 * DELIVERY_CEILING_TTL_MS).planningTaper).toEqual([{ fromPercent: 90, ceilingW: 900 }]);
  });

  it('keeps a confirmed taper through one lower plateau, which waits for its own confirmation', () => {
    const ledger = new BatteryVerificationLedger();
    teachTwice(ledger, 2000, level(86), 0);
    // One slow ramp reads 600 W after the confirmation window: live control
    // holds it, the plan keeps the taper it had.
    ledger.recordChargeCeiling(BATTERY, charged(600, level(87)), DELIVERY_CEILING_TTL_MS);
    expect(ceilingAt(ledger, DELIVERY_CEILING_TTL_MS)).toEqual({
      everyLevelW: 2500,
      taper: [{ fromPercent: 85, ceilingW: 600 }],
      planningTaper: [{ fromPercent: 85, ceilingW: 2000 }],
    });
    // The same low plateau again confirms it.
    ledger.recordChargeCeiling(BATTERY, charged(600, level(88)), 2 * DELIVERY_CEILING_TTL_MS);
    expect(ceilingAt(ledger, 2 * DELIVERY_CEILING_TTL_MS).planningTaper).toEqual([{ fromPercent: 85, ceilingW: 600 }]);
  });

  it('lifts a confirmed taper with a higher plateau, which waits for its own confirmation', () => {
    const ledger = new BatteryVerificationLedger();
    teachTwice(ledger, 1000, level(86), 0);
    ledger.recordChargeCeiling(BATTERY, charged(1500, level(87)), DELIVERY_CEILING_TTL_MS);
    expect(ceilingAt(ledger, DELIVERY_CEILING_TTL_MS).planningTaper).toEqual([]);
    ledger.recordChargeCeiling(BATTERY, charged(1500, level(88)), 2 * DELIVERY_CEILING_TTL_MS);
    expect(ceilingAt(ledger, 2 * DELIVERY_CEILING_TTL_MS).planningTaper).toEqual([{ fromPercent: 85, ceilingW: 1500 }]);
  });

  it('lifts the held low plateau, and keeps the confirmed taper, from a charge between them', () => {
    const ledger = new BatteryVerificationLedger();
    teachTwice(ledger, 2000, level(86), 0);
    ledger.recordChargeCeiling(BATTERY, charged(600, level(87)), DELIVERY_CEILING_TTL_MS);
    ledger.recordResponding(BATTERY, { signedW: 1200, toleranceW: TOLERANCE_W, level: level(87) },
      DELIVERY_CEILING_TTL_MS + 1000);
    expect(ceilingAt(ledger, DELIVERY_CEILING_TTL_MS + 1000)).toEqual({
      everyLevelW: 2500, taper: [], planningTaper: [{ fromPercent: 85, ceilingW: 2000 }],
    });
  });

  it('lifts a band from both live control and the plan once a charge passes it, even after live expiry', () => {
    const ledger = new BatteryVerificationLedger();
    teachTwice(ledger, 1000, level(82), 0);
    teachTwice(ledger, 300, level(96), 0);

    const laterMs = 2 * DELIVERY_CEILING_TTL_MS;
    ledger.recordResponding(BATTERY, { signedW: 2000, toleranceW: 50, level: level(88) }, laterMs);
    expect(ceilingAt(ledger, laterMs))
      .toEqual({ everyLevelW: 2500, taper: [], planningTaper: [{ fromPercent: 95, ceilingW: 300 }] });

    ledger.recordChargeCeiling(BATTERY, charged(700, level(86)), laterMs);
    ledger.recordResponding(BATTERY, { signedW: 2000, toleranceW: 50, level: level(87) }, laterMs + 1000);
    expect(ceilingAt(ledger, laterMs + 1000))
      .toEqual({ everyLevelW: 2500, taper: [], planningTaper: [{ fromPercent: 95, ceilingW: 300 }] });
  });

  it('lifts only the every-level lesson from a charge at an unreported level', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, charged(1000, level(50)), 0);
    teachTwice(ledger, 300, level(96), 0);

    ledger.recordResponding(BATTERY, { signedW: 2000, toleranceW: 50, level: undefined }, 1000);
    const taper = [{ fromPercent: 95, ceilingW: 300 }];
    expect(ceilingAt(ledger, 1000)).toEqual({ everyLevelW: 2500, taper, planningTaper: taper });
  });

  it('forgets every band once the battery is sign-inverted', () => {
    const ledger = new BatteryVerificationLedger();
    ledger.recordChargeCeiling(BATTERY, charged(300, level(96)), 0);
    ledger.recordSignInverted(BATTERY);
    expect(ceilingAt(ledger, 0)).toEqual({ everyLevelW: 2500, taper: [], planningTaper: [] });
  });
});

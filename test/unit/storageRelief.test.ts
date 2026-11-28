import { resolveStorageRecoveryHeadroom } from '../../lib/plan/battery/storageLimit';
import { storageSurplusFixture as resolveStorageSurplus } from '../helpers/storageSurplusFixture';
import { decideStorageReliefFixture } from '../helpers/storageReliefFixture';
import { withoutStorageWithheld } from '../../lib/plan/battery/storageLimit';
import {
  STORAGE_DECREASE_MIN_INTERVAL_MS,
  STORAGE_INPUT_MISSING_RELEASE_MS,
  decideStorageRelief,
  releaseStorageOnSilentMeter,
  sumWithheldKw,
  attachStorageDecisions,
  type StorageRelief,
} from '../../lib/plan/battery/storageRelief';
import {
  type StorageSurplusOffer,
  type SurplusDemand,
} from '../../lib/plan/planSurplusAbsorb';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { SURPLUS_TRACK_STEP_MIN_INTERVAL_MS } from '../../lib/plan/admission';
import type { StorageLeverState } from '../../lib/plan/planState';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { StorageDecision } from '../../lib/planContract/storageDecision';
import type {
  ObservedStorageInput,
  StoragePlanInputKind,
} from '../../packages/planner-types/src/planInputDevice';
import { STORAGE_RELIEF_SETTLE_WINDOW_MS } from '../../lib/plan/battery/storageLadder';
import { buildMeasuredPower } from '../utils/planContextPowerFixture';
import { buildPlanDevice, buildPlanInputDevice, resolveSurplusEligibilityForSpec } from '../utils/planTestUtils';

const NOW = 10_000_000;

/** The decisions the relief carries, by battery (`StorageStateSummary.decision`). */
const decisionsOf = (relief: StorageRelief): Map<string, StorageDecision> => new Map(relief.batteries.flatMap(
  (battery) => (battery.decision.kind === 'none' ? [] : [[battery.deviceId, battery.decision] as const]),
));
/** What restore and admission may not spend for the batteries, kW. */
const withheldKwOf = (relief: StorageRelief): number => sumWithheldKw(relief.batteries);

const batteryDevice = (): PlanInputDevice => buildPlanInputDevice({
  id: 'battery',
  name: 'Battery',
  isBatteryOrSolar: true,
  commandAuthority: false,
  binaryControllable: false,
  currentDrawKw: 0,
});

const battery = (overrides: Partial<ObservedStorageInput> = {}): PlanInputDevice & StoragePlanInputKind => ({
  ...batteryDevice(),
  storage: {
    reading: 'observed',
    range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    handBackDeferred: false,
    signedPowerW: 0,
    observedAtMs: 0,
    claimHeld: false,
    admissible: true,
    verdict: 'unverified',
    canSetDischargePower: true,
    deliveryCeilingW: 2500,
    chargeCeilingW: 2500,
    ownModeGridCharge: { kind: 'observed' },
    powerLimitControl: true,
    ...overrides,
  },
});

const unreadBattery = (admissible = true): PlanInputDevice & StoragePlanInputKind => ({
  ...batteryDevice(),
  storage: { reading: 'missing', handBackDeferred: false, claimHeld: true, admissible },
});

/** An offer as a spec states it: what the pool counted of the battery's charge is the producer's to say. */
type SpecOffer = Omit<StorageSurplusOffer, 'addedBackW'>;

/** What the allocator offers the battery at its turn, with what the consumers below it take. */
const offer = (
  availableW: number, demandAbove: SurplusDemand, belowW = 0,
): ReadonlyMap<string, SpecOffer> => new Map([['battery', { availableW, demandAbove, belowW }]]);

/** No willing device, and the house importing: nothing to store. */
const NO_OFFERS = offer(-5000, 'none');

/**
 * Each offer with what the pool counted of that battery's charge, as the
 * allocator answers it: the battery's claimant charge (`resolveStorageSurplus`).
 */
const withAddedBack = (
  device: PlanInputDevice,
  levers: Record<string, StorageLeverState>,
  drawKw: number,
  offers: ReadonlyMap<string, SpecOffer>,
): ReadonlyMap<string, StorageSurplusOffer> => {
  const { claimants } = resolveStorageSurplus([device], levers, drawKw * 1000);
  return new Map([...offers].map(([deviceId, spec]) => [deviceId, {
    ...spec, addedBackW: claimants.find((claimant) => claimant.deviceId === deviceId)?.chargeW ?? 0,
  }]));
};

/** A cycle against the binding pace: negative headroom is the deficit, kW. */
const cycle = (
  device: PlanInputDevice,
  headroomKw: number,
  levers: Record<string, StorageLeverState> = {},
  nowTs = NOW,
  drawKw = 5,
  offers: ReadonlyMap<string, SpecOffer> = NO_OFFERS,
): StorageRelief => decideStorageReliefFixture(
  [device], buildMeasuredPower({ drawKw, headroomKw }), levers, withAddedBack(device, levers, drawKw, offers), nowTs, 0,
);

/** A cycle in an exporting house, offering the battery this much surplus, W, after the consumers above it. */
const exporting = (
  device: PlanInputDevice,
  availableW: number,
  levers: Record<string, StorageLeverState> = {},
  nowTs = NOW,
  demandAbove: SurplusDemand = 'waiting',
): StorageRelief => cycle(device, 8, levers, nowTs, -1.5, offer(availableW, demandAbove));

const lever = (overrides: Partial<StorageLeverState> = {}): StorageLeverState => ({
  setpointW: -1500,
  purpose: 'limit',
  increaseDecidedAtMs: NOW - 10 * 60_000,
  creditBaseW: 0,
  lastDecreaseAtMs: NOW - 10 * 60_000,
  chargeRaisedAtMs: NOW - 10 * 60_000,
  lastNeedAtMs: NOW,
  limitedChargeW: 0,
  stepW: 5,
  reading: { kind: 'read' },
  ...overrides,
});

describe('the storage stage before shedding', () => {
  it('leaves the choice of new battery relief to shedding', () => {
    const relief = cycle(battery({ signedPowerW: 800 }), -1.2);

    expect(decisionsOf(relief).get('battery')).toMatchObject({ kind: 'setpoint', setpointW: 0 });
    expect(relief.levers.battery?.baseline).toBe(true);
    expect(relief.shed).toEqual({ netCreditKw: 0, relieving: false, drawMarginKw: 0 });
  });

  it('keeps a limit hold where shedding put it on a deficit, and raises nothing', () => {
    const relief = cycle(battery({ signedPowerW: -1500 }), -0.8, { battery: lever() });

    expect(decisionsOf(relief).get('battery')).toEqual({ kind: 'setpoint', setpointW: -1500, stepW: 5 });
    expect(relief.shed).toEqual({ netCreditKw: 0, relieving: true, drawMarginKw: 0.1 });
  });

  it('credits only the discharge the battery has not delivered yet, and nothing once the window lapses', () => {
    const settling = cycle(battery({ signedPowerW: -1000 }), -0.2, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    });
    expect(settling.shed.netCreditKw).toBeCloseTo(0.5);

    const lapsed = cycle(battery({ signedPowerW: -1000 }), -0.2, {
      battery: lever({ increaseDecidedAtMs: NOW - STORAGE_RELIEF_SETTLE_WINDOW_MS }),
    });
    expect(lapsed.shed.netCreditKw).toBe(0);
  });

  it('credits above what was already accounted for, never a charge it has not stopped yet', () => {
    // Asked for 1.5 kW of discharge while it still charged 800 W: the stopped
    // charge is pending relief's, so only the discharge is this term's.
    const charging = cycle(battery({ signedPowerW: 800 }), -0.2, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    });
    expect(charging.shed.netCreditKw).toBeCloseTo(1.5);

    const raised = cycle(battery({ signedPowerW: -200 }), -0.2, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000, creditBaseW: 1000 }),
    });
    expect(raised.shed.netCreditKw).toBeCloseTo(0.5);
  });

  it('credits nothing for a capped charge: its fall is pending relief\'s', () => {
    const relief = cycle(battery({ signedPowerW: 2000 }), -0.2, {
      battery: lever({ setpointW: 500, increaseDecidedAtMs: NOW - 5_000 }),
    });
    expect(decisionsOf(relief).get('battery')).toMatchObject({ setpointW: 500 });
    expect(relief.shed).toEqual({ netCreditKw: 0, relieving: false, drawMarginKw: 0 });
    expect(relief.batteries[0]).toMatchObject({ claim: 'charge_limit' });
  });

  it('credits nothing for a re-probing battery', () => {
    const relief = cycle(battery({ verdict: 'reprobing' }), -1, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    });

    expect(decisionsOf(relief).get('battery')).toMatchObject({ setpointW: -1500 });
    expect(relief.shed.netCreditKw).toBe(0);
  });
});

describe('how the overview names a battery PELS does not hold', () => {
  const holdOf = (relief: StorageRelief) => attachStorageDecisions([
    buildPlanDevice({ id: 'battery', name: 'Battery', isBatteryOrSolar: true }),
  ], relief)[0]?.storageHold;

  it('names one with Power-limit control off as left to its own app', () => {
    expect(holdOf(cycle(battery({ powerLimitControl: false }), 1))).toEqual({ kind: 'power_limit_off' });
    expect(holdOf(releaseStorageOnSilentMeter([battery({ powerLimitControl: false })], {})))
      .toEqual({ kind: 'power_limit_off' });
  });

  it('names an idle managed hold', () => {
    expect(holdOf(cycle(battery({ claimHeld: true }), 1))).toEqual({ kind: 'plan_wait' });
  });
});

describe('storage relief hysteresis', () => {
  it('holds the setpoint inside the deadband', () => {
    expect(decisionsOf(cycle(battery({ signedPowerW: -1500 }), 0.15, { battery: lever() })).get('battery'))
      .toMatchObject({ setpointW: -1500 });
  });

  it('steps down past the deadband, leaving the deadband as headroom', () => {
    const relief = cycle(battery({ signedPowerW: -1500 }), 0.7, { battery: lever() });
    expect(decisionsOf(relief).get('battery')).toMatchObject({ setpointW: -1000 });
    expect(relief.levers.battery?.lastDecreaseAtMs).toBe(NOW);
  });

  it('steps to 0 W once the discharge needed is under the deadband, the charge still stopped', () => {
    const relief = cycle(battery({ signedPowerW: -300 }), 0.3, { battery: lever({ setpointW: -300 }) });
    expect(decisionsOf(relief).get('battery')).toMatchObject({ setpointW: 0 });
    expect(relief.batteries[0]).toMatchObject({ claim: 'charge_limit' });
  });

  it('defers a new grid charge before reserving the room for discharge recovery', () => {
    const held = battery({ signedPowerW: -1500 });
    const charging = {
      ...battery({ continuousPlan: { reason: 'charge_grid', setpointW: 2500, validUntilMs: NOW + 60_000 } }),
      id: 'charging',
    };
    const offer = { availableW: 0, demandAbove: 'none', belowW: 0, addedBackW: 0 } as const;
    const offers = new Map([['battery', offer], ['charging', offer]]);
    const power = buildMeasuredPower({ drawKw: 3, headroomKw: 0.7, capacityHeadroomKw: 0.7 });
    const relief = decideStorageReliefFixture([held, charging], power, { battery: lever() }, offers, NOW, 0);
    expect(decisionsOf(relief).get('battery')).toMatchObject({ setpointW: -1000 });
    expect(decisionsOf(relief).get('charging')).toMatchObject({ setpointW: 0 });
  });

  it('keeps a small hold when returning to zero would breach the physical limit', () => {
    const relief = cycle(battery({ signedPowerW: -300 }), 0.15, { battery: lever({ setpointW: -300 }) });
    expect(decisionsOf(relief).get('battery')).toMatchObject({ setpointW: -300 });
  });

  it('eases a hard hold during daily-only pressure without exposing its discharge to admission', () => {
    const power = buildMeasuredPower({ drawKw: 3, headroomKw: -1, capacityHeadroomKw: 0.7, budgetHeadroomKw: -1 });
    const device = battery({ signedPowerW: -1500 });
    const levers = { battery: lever() };
    const room = resolveStorageRecoveryHeadroom(
      power, { kind: 'on', paceKw: 3.7, shortfallThresholdKw: 4 }, false, 0,
    );
    const relief = decideStorageRelief([device], power, levers, withAddedBack(device, levers, power.drawKw, NO_OFFERS),
      NOW, 0, room);

    expect(decisionsOf(relief).get('battery')).toMatchObject({ setpointW: -1000 });
    expect(withoutStorageWithheld(power, relief, [device], 0).capacityHeadroom).toEqual({ kind: 'on', kw: -0.8 });
    expect(relief.shed.netCreditKw).toBe(0);
  });

  it('eases the last battery first and reserves its pending taper across readings', () => {
    const first = battery({ signedPowerW: -1500 });
    const last = { ...first, id: 'later', priority: 1 };
    const devices = [last, first];
    const power = buildMeasuredPower({ drawKw: 3, headroomKw: 0.7 });
    const offers = new Map([
      ['battery', { availableW: 0, demandAbove: 'none', belowW: 0, addedBackW: 0 } as const],
      ['later', { availableW: 0, demandAbove: 'none', belowW: 0, addedBackW: 0 } as const],
    ]);
    const relief = decideStorageReliefFixture(devices, power, { battery: lever(), later: lever() }, offers, NOW, 0);
    expect(decisionsOf(relief).get('later')).toMatchObject({ setpointW: -1000 });
    expect(decisionsOf(relief).get('battery')).toMatchObject({ setpointW: -1500 });

    const lagging = decideStorageReliefFixture(devices, power, relief.levers, offers, NOW + 1000, 0);
    expect(decisionsOf(lagging).get('later')).toMatchObject({ setpointW: -1000 });
    expect(decisionsOf(lagging).get('battery')).toMatchObject({ setpointW: -1500 });
  });

  it.each([
    { change: 'hand-back', purpose: 'limit', powerLimitControl: false, decision: 'release' },
    { change: 'scheduled withdrawal', purpose: 'continuous', powerLimitControl: true, decision: 'setpoint' },
  ] as const)('reserves $change before easing a held discharge', ({ purpose, powerLimitControl, decision }) => {
    const held = battery({ signedPowerW: -1500, claimHeld: true });
    const withdrawing = { ...battery({ signedPowerW: -600, claimHeld: true, powerLimitControl }), id: 'withdrawing' };
    const offers = new Map([
      ['battery', { availableW: 0, demandAbove: 'none', belowW: 0, addedBackW: 0 } as const],
      ['withdrawing', { availableW: 0, demandAbove: 'none', belowW: 0, addedBackW: 0 } as const],
    ]);
    const power = buildMeasuredPower({ drawKw: 3, headroomKw: 1.4 });
    const levers = { battery: lever(), withdrawing: lever({ purpose, setpointW: -400 }) };
    const relief = decideStorageReliefFixture([held, withdrawing], power, levers, offers, NOW, 0);

    expect(decisionsOf(relief).get('withdrawing')).toMatchObject({ kind: decision });
    expect(decisionsOf(relief).get('battery')).toMatchObject({ setpointW: -900 });
    expect(relief.shed.netCreditKw).toBeCloseTo(-0.6);
  });

  it('paces step-downs', () => {
    const recent = { battery: lever({ lastDecreaseAtMs: NOW - STORAGE_DECREASE_MIN_INTERVAL_MS + 1_000 }) };
    expect(decisionsOf(cycle(battery({ signedPowerW: -1500 }), 0.7, recent)).get('battery'))
      .toMatchObject({ setpointW: -1500 });
  });

  it('does not step down while an increase is still settling', () => {
    expect(decisionsOf(cycle(battery({ signedPowerW: -1500 }), 0.7, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    })).get('battery')).toMatchObject({ setpointW: -1500 });
  });
});

describe('storage relief release', () => {
  it('keeps a limit hold at 0 W however long: only the restore lane hands it back', () => {
    const held = { battery: lever({ setpointW: 0, lastNeedAtMs: NOW - 60 * 60_000 }) };
    const relief = cycle(battery({ claimHeld: true }), 5, held);

    expect(decisionsOf(relief).get('battery')).toMatchObject({ kind: 'setpoint', setpointW: 0 });
    expect(relief.levers.battery?.purpose).toBe('limit');
  });

  it('hands a surplus hold back at once when the owner turns Power-limit control off', () => {
    const relief = exporting(battery({ claimHeld: true, signedPowerW: 400, powerLimitControl: false }), 500, {
      battery: lever({ setpointW: 400, purpose: 'continuous', limitedChargeW: 2000 }),
    });

    expect(decisionsOf(relief).get('battery')).toEqual({ kind: 'release', reason: 'limit_off' });
    expect(relief.levers).toEqual({});
  });

  it('never starts a surplus claim on a battery whose Power-limit control is off', () => {
    // Its own mode stores 2 kW and a waiting device would take 1.5 kW of it.
    const relief = exporting(battery({ signedPowerW: 2000, powerLimitControl: false }), 500, {}, NOW, 'waiting');

    expect(decisionsOf(relief).size).toBe(0);
    expect(relief.levers).toEqual({});
    expect(relief.batteries[0]).toMatchObject({ claim: 'none', powerLimitOff: true });
  });

  it('hands back a claim it still holds on a battery whose Power-limit control is off', () => {
    const relief = exporting(battery({ signedPowerW: 0, claimHeld: true, powerLimitControl: false }), 500);
    expect(decisionsOf(relief).get('battery')).toEqual({ kind: 'release', reason: 'limit_off' });
  });

  it('hands a limit hold back at once when the owner turns Power-limit control off', () => {
    const relief = cycle(battery({ claimHeld: true, signedPowerW: -1500, powerLimitControl: false }), 0.1, {
      battery: lever(),
    });

    expect(decisionsOf(relief).get('battery')).toEqual({ kind: 'release', reason: 'limit_off' });
    expect(relief.levers).toEqual({});
    expect(relief.shed.netCreditKw).toBeCloseTo(-1.5);
  });

  it.each([
    ['not_responding', { verdict: 'not_responding' as const }],
    ['sign_inverted', { verdict: 'sign_inverted' as const }],
    ['not_admissible', { admissible: false }],
  ])('releases a discharging %s battery and counts its discharge as deficit', (reason, overrides) => {
    const relief = cycle(battery({ claimHeld: true, signedPowerW: -1500, ...overrides }), 0.1, { battery: lever() });

    expect(decisionsOf(relief).get('battery')).toEqual({ kind: 'release', reason });
    expect(relief.shed).toEqual({ netCreditKw: -1.5, relieving: false, drawMarginKw: 0 });
    expect(withheldKwOf(relief)).toBeCloseTo(1.5);
  });

  it('decides nothing for a battery it neither drives nor holds', () => {
    expect(decisionsOf(cycle(battery({ verdict: 'not_responding' }), -2)).size).toBe(0);
    expect(decisionsOf(cycle(battery(), 1)).get('battery')).toMatchObject({ kind: 'setpoint', setpointW: 0 });
  });

  it('hands back every held battery on meter silence', () => {
    const relief = releaseStorageOnSilentMeter([battery({ claimHeld: true })], { battery: lever() });
    expect(decisionsOf(relief).get('battery')).toEqual({ kind: 'release', reason: 'meter_silent' });
    expect(relief.levers).toEqual({});
  });
});

describe('storage relief without a reading', () => {
  it('keeps the last hold uncredited, then releases it once the reading has been missing too long', () => {
    const kept = cycle(unreadBattery(), -1, { battery: lever({ increaseDecidedAtMs: NOW - 5_000 }) });
    expect(decisionsOf(kept).get('battery')).toEqual({ kind: 'setpoint', setpointW: -1500, stepW: 5 });
    expect(kept.shed.netCreditKw).toBe(0);
    expect(withheldKwOf(kept)).toBeCloseTo(1.5);
    expect(kept.levers.battery?.reading).toEqual({ kind: 'unread', sinceMs: NOW });

    const released = cycle(unreadBattery(), -1, kept.levers, NOW + STORAGE_INPUT_MISSING_RELEASE_MS);
    expect(decisionsOf(released).get('battery')).toEqual({ kind: 'release', reason: 'input_missing' });
    expect(released.shed.netCreditKw).toBeCloseTo(-1.5);
  });

  it('releases at once when the unread battery is no longer admissible', () => {
    expect(decisionsOf(cycle(unreadBattery(false), -1, { battery: lever() })).get('battery'))
      .toEqual({ kind: 'release', reason: 'not_admissible' });
  });

  it('hands back a hold whose battery left the plan after the missing-input window', () => {
    const heater = buildPlanInputDevice({ id: 'heater', controllable: true });
    const kept = decideStorageReliefFixture([heater], buildMeasuredPower(), { battery: lever() }, new Map(), NOW, 0);
    expect(kept.levers.battery).toBeDefined();
    expect(decisionsOf(kept).size).toBe(0);

    const dropped = decideStorageReliefFixture(
      [heater], buildMeasuredPower(), kept.levers, new Map(), NOW + STORAGE_INPUT_MISSING_RELEASE_MS, 0,
    );
    expect(dropped.levers).toEqual({});
    expect(decisionsOf(dropped).get('battery')).toEqual({ kind: 'release', reason: 'not_admissible' });
  });

  it('withholds deferred discharge from restores without adding it to the shed deficit', () => {
    const relief = cycle(battery({
      claimHeld: true, signedPowerW: -1500, admissible: false, handBackDeferred: true,
    }), 0.5, { battery: lever() });
    expect(relief.shed.netCreditKw).toBe(0);
    expect(withheldKwOf(relief)).toBe(1.5);
  });

  it('never funds charge inside the battery exclusion band', () => {
    const range = { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: -1000, excludeMaxW: 1000 };
    const charge = exporting(battery({ range, signedPowerW: 2000 }), 700);
    expect(decisionsOf(charge).get('battery')).toMatchObject({ setpointW: 0 });
  });

  it.each([-1, 0.5])('keeps a learned off-grid ceiling writable with %s kW headroom', (headroomKw) => {
    const range = { minW: -2500, maxW: 2500, stepW: 500, excludeMinW: 0, excludeMaxW: 0 };
    const relief = cycle(battery({
      range, signedPowerW: -2000, claimHeld: true, deliveryCeilingW: 1900,
    }), headroomKw, { battery: lever({ setpointW: -2000, stepW: 500 }) });
    expect(decisionsOf(relief).get('battery')).toMatchObject({ setpointW: -1500 });
  });
});

describe('routine managed solar charging', () => {
  it('starts charging from ranked spare solar without a vendor charge to cap', () => {
    expect(decisionsOf(exporting(battery(), 1000, {}, NOW, 'none')).get('battery'))
      .toMatchObject({ kind: 'setpoint', setpointW: 900 });
  });

  it('settles at managed idle once the sun drops or the battery stops taking charge', () => {
    const charging = exporting(battery(), 1500, {}, NOW, 'none');
    for (const next of [
      cycle(battery({ claimHeld: true, signedPowerW: 1400 }), 2, charging.levers, NOW + 1000),
      exporting(battery({ claimHeld: true, chargeCeilingW: 0 }), 1500, charging.levers, NOW + 1000, 'none'),
    ]) {
      expect(decisionsOf(next).get('battery')).toMatchObject({ kind: 'setpoint', setpointW: 0 });
      expect(next.levers.battery).toMatchObject({ baseline: true });
    }
  });

  it('paces a charge increase and promptly reduces a lost solar share', () => {
    const initial = exporting(battery(), 600, {}, NOW, 'none');
    const following = battery({ claimHeld: true, signedPowerW: 500 });
    const soon = exporting(following, 1400, initial.levers, NOW + 1000);
    expect(soon.batteries[0].setpointW).toBe(500);
    const later = exporting(following, 1400, initial.levers, NOW + SURPLUS_TRACK_STEP_MIN_INTERVAL_MS);
    expect(later.batteries[0].setpointW).toBe(1300);
    const reduced = exporting(battery({ claimHeld: true, signedPowerW: 1300 }), 400, later.levers,
      NOW + SURPLUS_TRACK_STEP_MIN_INTERVAL_MS + 1000);
    expect(reduced.batteries[0].setpointW).toBe(300);
  });
});

describe('the batteries in the surplus pool', () => {
  const claimed = (device: PlanInputDevice, levers: Record<string, StorageLeverState>, signedNetW: number) => (
    resolveStorageSurplus([device], levers, signedNetW)
  );
  const chargeOf = (device: PlanInputDevice, levers: Record<string, StorageLeverState>, signedNetW: number) => (
    claimed(device, levers, signedNetW).claimants[0]?.chargeW
  );

  it('ranks a claimable battery at its own priority', () => {
    const ranked = { ...battery({ signedPowerW: 2000 }), priority: 3 };
    expect(resolveStorageSurplus([ranked], {}, 0)).toMatchObject({
      claimants: [{ deviceId: 'battery', priority: 3, chargeW: 2000, reservedW: 2000 }], dischargeW: 0,
    });
  });

  it('counts what PELS charges a held battery with, up to what it asked', () => {
    expect(chargeOf(battery({ signedPowerW: 1200 }), { battery: lever({ setpointW: 1500 }) }, 0)).toBe(1200);
    expect(chargeOf(battery({ signedPowerW: 1800 }), { battery: lever({ setpointW: 1500 }) }, 0)).toBe(1500);
  });

  it('counts the solar a claimable battery stores in its own mode, less any import, smoothly', () => {
    const own = battery({ signedPowerW: 2000 });
    expect(chargeOf(own, {}, 0)).toBe(2000);
    expect(chargeOf(own, {}, 300)).toBe(1700);
    expect(chargeOf(own, {}, 350)).toBe(1650);
    expect(chargeOf(own, {}, 400)).toBe(1600);
    // Charging from the grid: none of it is surplus.
    expect(chargeOf(own, {}, 2500)).toBe(0);
  });

  it.each([
    ['Managed off', { admissible: false }],
    ['not responding', { verdict: 'not_responding' as const }],
    ['sign-inverted', { verdict: 'sign_inverted' as const }],
  ])('makes no claim for a battery that is %s: its charge is household load', (_label, overrides) => {
    expect(claimed(battery({ signedPowerW: 2000, ...overrides }), {}, 0)).toEqual({ claimants: [], dischargeW: 0 });
    expect(claimed(battery({ signedPowerW: 2000, claimHeld: true, ...overrides }), {
      battery: lever({ setpointW: 1500, purpose: 'continuous' }),
    }, 0)).toEqual({ claimants: [], dischargeW: 0 });
  });

  it('makes no claim for a battery whose Power-limit control is off, and still keeps its discharge out', () => {
    // Owner ruling, 2026-10-06: PELS never takes it over, so its charge is household load.
    expect(claimed(battery({ signedPowerW: 2000, powerLimitControl: false }), {}, 0))
      .toEqual({ claimants: [], dischargeW: 0 });
    expect(claimed(battery({ signedPowerW: -1200, powerLimitControl: false }), {}, -1200))
      .toEqual({ claimants: [], dischargeW: 1200 });
  });

  it('never offers a battery\'s own discharge: it is taken out of the export', () => {
    expect(claimed(battery({ signedPowerW: -5000 }), {}, -5000)).toMatchObject({
      claimants: [{ deviceId: 'battery', priority: 1, chargeW: 0, reservedW: 0 }], dischargeW: 5000,
    });
    // A held discharge stepping down offers the devices none of it either.
    expect(claimed(battery({ signedPowerW: -800 }), { battery: lever() }, -800)).toEqual({
      claimants: [{ deviceId: 'battery', priority: 1, chargeW: 0, reservedW: 0 }], dischargeW: 800,
    });
    expect(claimed(battery({ signedPowerW: -800, admissible: false }), {}, -800)).toEqual({
      claimants: [], dischargeW: 800,
    });
  });

  it('offers nothing of a battery it cannot read, and counts what PELS last held it to discharge', () => {
    expect(claimed(unreadBattery(), { battery: lever() }, 0)).toEqual({
      claimants: [], dischargeW: Math.max(0, -lever().setpointW),
    });
  });
});

describe('battery charge ranked against the consumers below it', () => {
  /** A battery that follows its hold, at this priority; 5 kW of charge range. */
  const ranked = (id: string, priority: number, overrides: Partial<ObservedStorageInput>): PlanInputDevice => {
    const base = battery({
      range: { minW: -5000, maxW: 5000, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
      chargeCeilingW: 5000,
      ownModeGridCharge: { kind: 'observed' },
      ...overrides,
    });
    return { ...base, id, name: id, priority };
  };
  /** A surplus hold raised to `setpointW` past the `ownModeW` its own mode charged when PELS took it. */
  const raised = (setpointW: number): StorageLeverState => lever({
    setpointW, purpose: 'continuous',
  });
  /** A 1.5 kW tank on "Use solar surplus", ranked first and waiting to start. */
  const tank = (): PlanInputDevice => buildPlanInputDevice({
    id: 'tank',
    name: 'tank',
    priority: 1,
    deviceType: 'temperature',
    currentTemperature: 50,
    expectedPowerKw: 1.5,
    currentDrawKw: 0,
    targets: [{ id: 'target_temperature', value: 20, unit: 'C', min: 0, max: 95, step: 0.5 }],
  });

  /** The allocator, then the storage stage, on one reading: the charge each battery holds after it, W. */
  const decide = (
    devices: PlanInputDevice[],
    levers: Record<string, StorageLeverState>,
    signedNetW: number,
  ): Record<string, number> => {
    const offers = resolveSurplusEligibilityForSpec({
      devices,
      state: createPlanEngineState(),
      signedNetKw: signedNetW / 1000,
      inferredSurplusKw: 0,
      storage: resolveStorageSurplus(devices, levers, signedNetW),
      excludeIds: new Set(),
      getConfig: () => ({ enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusLiftC: 2 }),
      nowTs: NOW,
    });
    const relief = decideStorageReliefFixture(
      devices, buildMeasuredPower({ drawKw: signedNetW / 1000, headroomKw: 8 }), levers, offers, NOW, 0,
    );
    const chargeOf = (id: string, observedW: number): number => {
      const decision: StorageDecision | undefined = decisionsOf(relief).get(id);
      return decision?.kind === 'setpoint' ? decision.setpointW : observedW;
    };
    return { upper: chargeOf('upper', 1000), lower: chargeOf('lower', 1000) };
  };

  it('gives a waiting device its share, then fills the higher-ranked battery first', () => {
    const devices = [
      tank(),
      ranked('upper', 5, { signedPowerW: 1000, claimHeld: true }),
      ranked('lower', 6, { signedPowerW: 1000 }),
    ];
    const charges = decide(devices, { upper: raised(1000) }, -1000);
    expect(charges.upper).toBe(1400);
    expect(charges.lower).toBe(0);
    expect(charges.upper + charges.lower + 1500).toBeLessThanOrEqual(3000);
  });

  it('offers the lower-ranked battery the solar the higher-ranked battery cannot store', () => {
    const devices = [
      ranked('upper', 5, { signedPowerW: 1000, chargeCeilingW: 1200 }),
      ranked('lower', 6, { signedPowerW: 1000 }),
    ];
    expect(decide(devices, {}, -500)).toEqual({ upper: 1200, lower: 1200 });
  });
});

describe('the surplus offer contract', () => {
  it('treats a holdable battery the allocator made no offer to as a broken producer', () => {
    expect(() => cycle(battery({ signedPowerW: 2000 }), 8, {}, NOW, -1.5, new Map()))
      .toThrow('No surplus offer for holdable battery battery');
  });

  it('asks no offer of a battery it may not hold', () => {
    expect(decisionsOf(cycle(battery({ signedPowerW: 2000, admissible: false }), 8, {}, NOW, -1.5, new Map())).size).toBe(0);
  });
});

describe('storage discharge as restore sees it', () => {
  it('takes the held discharge off every headroom axis and leaves the draw measured', () => {
    const power = buildMeasuredPower({ drawKw: 2, headroomKw: 1, capacityHeadroomKw: 1, gridHeadroomKw: 0.8, budgetHeadroomKw: 0.5 });
    const relief = cycle(battery({ signedPowerW: -1500 }), 1, { battery: lever() });

    expect(withoutStorageWithheld(power, relief, [], 0)).toEqual({
      ...power, headroom: { kind: 'on', kw: -0.5 }, capacityHeadroom: { kind: 'on', kw: -0.5 },
      gridHeadroom: { kind: 'on', kw: -0.7 }, budgetHeadroom: { kind: 'on', kw: -1 },
    });
  });

  it('in simulation, starts from the room the held discharge would have left, so it is withheld once', () => {
    const power = buildMeasuredPower({ drawKw: 2, headroomKw: 1, capacityHeadroomKw: 1, gridHeadroomKw: 0.8, budgetHeadroomKw: 0.5 });
    const relief = cycle(battery({ signedPowerW: -1500 }), 1, { battery: lever() });
    // Measured at 0 W while held at -1.5 kW: live control's reading would show the 1.5 kW as room.
    const undeliveredW = 1500;
    expect(withoutStorageWithheld(power, relief, [], undeliveredW).headroom)
      .toEqual({ kind: 'on', kw: 1 + 1.5 - relief.batteries[0]!.withheldW / 1000 });
  });
});

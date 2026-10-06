import {
  STORAGE_DECREASE_MIN_INTERVAL_MS,
  STORAGE_INPUT_MISSING_RELEASE_MS,
  STORAGE_SURPLUS_RELEASE_DWELL_MS,
  decideStorageRelief,
  releaseStorageOnSilentMeter,
  resolveStorageSurplus,
  withoutStorageWithheld,
  attachStorageDecisions,
  type StorageRelief,
} from '../../lib/plan/battery/storageRelief';
import {
  resolveSurplusEligibility,
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
import { buildPlanDevice, buildPlanInputDevice } from '../utils/planTestUtils';

const NOW = 10_000_000;

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
    stepW: 5,
    signedPowerW: 0,
    claimHeld: false,
    admissible: true,
    verdict: 'unverified',
    deliveryCeilingW: 2500,
    chargeCeilingW: 2500,
    powerLimitControl: true,
    ...overrides,
  },
});

const unreadBattery = (admissible = true): PlanInputDevice & StoragePlanInputKind => ({
  ...batteryDevice(),
  storage: { reading: 'missing', handBackDeferred: false, claimHeld: true, admissible },
});

/** What the allocator offers the battery at its turn, with what the consumers below it take. */
const offer = (
  availableW: number, demandAbove: SurplusDemand, belowW = 0,
): ReadonlyMap<string, StorageSurplusOffer> => new Map([['battery', { availableW, demandAbove, belowW }]]);

/** No willing device, and the house importing: nothing to store. */
const NO_OFFERS = offer(-5000, 'none');

/** A cycle against the binding pace: negative headroom is the deficit, kW. */
const cycle = (
  device: PlanInputDevice,
  headroomKw: number,
  levers: Record<string, StorageLeverState> = {},
  nowTs = NOW,
  drawKw = 5,
  offers: ReadonlyMap<string, StorageSurplusOffer> = NO_OFFERS,
): StorageRelief => decideStorageRelief([device], buildMeasuredPower({ drawKw, headroomKw }), levers, offers, nowTs);

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
  preClaimSignedW: 0,
  ownModeChargeW: 0,
  stepW: 5,
  reading: { kind: 'read' },
  ...overrides,
});

describe('the storage stage before shedding', () => {
  it('never limits a battery for a deficit: that is shedding\'s choice, at its place in the order', () => {
    const relief = cycle(battery({ signedPowerW: 800 }), -1.2, {}, NOW, 5, offer(2000, 'waiting'));

    expect(relief.decisions.size).toBe(0);
    expect(relief.levers).toEqual({});
    expect(relief.shed).toEqual({ netCreditKw: 0, relieving: false, drawMarginKw: 0 });
  });

  it('keeps a limit hold where shedding put it on a deficit, and raises nothing', () => {
    const relief = cycle(battery({ signedPowerW: -1500 }), -0.8, { battery: lever() });

    expect(relief.decisions.get('battery')).toEqual({ kind: 'setpoint', setpointW: -1500, stepW: 5 });
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
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 500 });
    expect(relief.shed).toEqual({ netCreditKw: 0, relieving: false, drawMarginKw: 0 });
    expect(relief.batteries[0]).toMatchObject({ claim: 'charge_limit' });
  });

  it('credits nothing for a re-probing battery', () => {
    const relief = cycle(battery({ verdict: 'reprobing' }), -1, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    });

    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: -1500 });
    expect(relief.shed.netCreditKw).toBe(0);
  });
});

describe('how the overview names a battery PELS does not hold', () => {
  const holdOf = (relief: StorageRelief) => attachStorageDecisions([
    buildPlanDevice({ id: 'battery', name: 'Battery', isBatteryOrSolar: true }),
  ], relief)[0]?.storageHold;

  it('names one with Power-limit control off as storing spare solar only', () => {
    expect(holdOf(cycle(battery({ powerLimitControl: false, claimHeld: true }), 1))).toEqual({ kind: 'solar_only' });
  });

  it('names one with Power-limit control on as waiting for the limit or solar', () => {
    expect(holdOf(cycle(battery({ claimHeld: true }), 1))).toEqual({ kind: 'none' });
  });
});

describe('storage relief hysteresis', () => {
  it('holds the setpoint inside the deadband', () => {
    expect(cycle(battery({ signedPowerW: -1500 }), 0.15, { battery: lever() }).decisions.get('battery'))
      .toMatchObject({ setpointW: -1500 });
  });

  it('steps down past the deadband, leaving the deadband as headroom', () => {
    const relief = cycle(battery({ signedPowerW: -1500 }), 0.7, { battery: lever() });
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: -1000 });
    expect(relief.levers.battery?.lastDecreaseAtMs).toBe(NOW);
  });

  it('steps to 0 W once the discharge needed is under the deadband, the charge still stopped', () => {
    const relief = cycle(battery({ signedPowerW: -300 }), 0.15, { battery: lever({ setpointW: -300 }) });
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 0 });
    expect(relief.batteries[0]).toMatchObject({ claim: 'charge_limit' });
  });

  it('paces step-downs', () => {
    const recent = { battery: lever({ lastDecreaseAtMs: NOW - STORAGE_DECREASE_MIN_INTERVAL_MS + 1_000 }) };
    expect(cycle(battery({ signedPowerW: -1500 }), 0.7, recent).decisions.get('battery'))
      .toMatchObject({ setpointW: -1500 });
  });

  it('does not step down while an increase is still settling', () => {
    expect(cycle(battery({ signedPowerW: -1500 }), 0.7, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    }).decisions.get('battery')).toMatchObject({ setpointW: -1500 });
  });
});

describe('storage relief release', () => {
  it('keeps a limit hold at 0 W however long: only the restore lane hands it back', () => {
    const held = { battery: lever({ setpointW: 0, lastNeedAtMs: NOW - 60 * 60_000, preClaimSignedW: 800 }) };
    const relief = cycle(battery({ claimHeld: true }), 5, held);

    expect(relief.decisions.get('battery')).toMatchObject({ kind: 'setpoint', setpointW: 0 });
    expect(relief.levers.battery?.purpose).toBe('limit');
  });

  it('hands a limit hold back at once when the owner turns Power-limit control off', () => {
    const relief = cycle(battery({ claimHeld: true, signedPowerW: -1500, powerLimitControl: false }), 0.1, {
      battery: lever(),
    });

    expect(relief.decisions.get('battery')).toEqual({ kind: 'release', reason: 'limit_off' });
    expect(relief.levers).toEqual({});
    expect(relief.shed.netCreditKw).toBeCloseTo(-1.5);
  });

  it.each([
    ['not_responding', { verdict: 'not_responding' as const }],
    ['sign_inverted', { verdict: 'sign_inverted' as const }],
    ['not_admissible', { admissible: false }],
  ])('releases a discharging %s battery and counts its discharge as deficit', (reason, overrides) => {
    const relief = cycle(battery({ claimHeld: true, signedPowerW: -1500, ...overrides }), 0.1, { battery: lever() });

    expect(relief.decisions.get('battery')).toEqual({ kind: 'release', reason });
    expect(relief.shed).toEqual({ netCreditKw: -1.5, relieving: false, drawMarginKw: 0 });
    expect(relief.withheldKw).toBeCloseTo(1.5);
  });

  it('decides nothing for a battery it neither drives nor holds', () => {
    expect(cycle(battery({ verdict: 'not_responding' }), -2).decisions.size).toBe(0);
    expect(cycle(battery(), 1).decisions.size).toBe(0);
  });

  it('hands back every held battery on meter silence', () => {
    const relief = releaseStorageOnSilentMeter([battery({ claimHeld: true })], { battery: lever() });
    expect(relief.decisions.get('battery')).toEqual({ kind: 'release', reason: 'meter_silent' });
    expect(relief.levers).toEqual({});
  });
});

describe('storage relief without a reading', () => {
  it('keeps the last hold uncredited, then releases it once the reading has been missing too long', () => {
    const kept = cycle(unreadBattery(), -1, { battery: lever({ increaseDecidedAtMs: NOW - 5_000 }) });
    expect(kept.decisions.get('battery')).toEqual({ kind: 'setpoint', setpointW: -1500, stepW: 5 });
    expect(kept.shed.netCreditKw).toBe(0);
    expect(kept.withheldKw).toBeCloseTo(1.5);
    expect(kept.levers.battery?.reading).toEqual({ kind: 'unread', sinceMs: NOW });

    const released = cycle(unreadBattery(), -1, kept.levers, NOW + STORAGE_INPUT_MISSING_RELEASE_MS);
    expect(released.decisions.get('battery')).toEqual({ kind: 'release', reason: 'input_missing' });
    expect(released.shed.netCreditKw).toBeCloseTo(-1.5);
  });

  it('releases at once when the unread battery is no longer admissible', () => {
    expect(cycle(unreadBattery(false), -1, { battery: lever() }).decisions.get('battery'))
      .toEqual({ kind: 'release', reason: 'not_admissible' });
  });

  it('hands back a hold whose battery left the plan after the missing-input window', () => {
    const heater = buildPlanInputDevice({ id: 'heater', controllable: true });
    const kept = decideStorageRelief([heater], buildMeasuredPower(), { battery: lever() }, NO_OFFERS, NOW);
    expect(kept.levers.battery).toBeDefined();
    expect(kept.decisions.size).toBe(0);

    const dropped = decideStorageRelief(
      [heater], buildMeasuredPower(), kept.levers, NO_OFFERS, NOW + STORAGE_INPUT_MISSING_RELEASE_MS,
    );
    expect(dropped.levers).toEqual({});
    expect(dropped.decisions.get('battery')).toEqual({ kind: 'release', reason: 'not_admissible' });
  });

  it('withholds deferred discharge from restores without adding it to the shed deficit', () => {
    const relief = cycle(battery({
      claimHeld: true, signedPowerW: -1500, admissible: false, handBackDeferred: true,
    }), 0.5, { battery: lever() });
    expect(relief.shed.netCreditKw).toBe(0);
    expect(relief.withheldKw).toBe(1.5);
  });

  it('never funds charge inside the battery exclusion band', () => {
    const range = { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: -1000, excludeMaxW: 1000 };
    const charge = exporting(battery({ range, signedPowerW: 2000 }), 700);
    expect(charge.decisions.get('battery')).toMatchObject({ setpointW: 0 });
  });

  it.each([-1, 0.5])('keeps a learned off-grid ceiling writable with %s kW headroom', (headroomKw) => {
    const range = { minW: -2500, maxW: 2500, stepW: 500, excludeMinW: 0, excludeMaxW: 0 };
    const relief = cycle(battery({
      range, stepW: 500, signedPowerW: -2000, claimHeld: true, deliveryCeilingW: 1900,
    }), headroomKw, { battery: lever({ setpointW: -2000, stepW: 500 }) });
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: -1500 });
  });
});

describe('storage charge for the devices', () => {
  /** A battery PELS took from its own mode's 2 kW charge and holds at 400 W for a device. */
  const capped = (overrides: Partial<StorageLeverState> = {}): Record<string, StorageLeverState> => ({
    battery: lever({ setpointW: 400, purpose: 'surplus', preClaimSignedW: 2000, ...overrides }),
  });
  const following = (signedPowerW = 400): PlanInputDevice => battery({ signedPowerW, claimHeld: true });

  it('caps the charge its own mode takes to what a device waiting to start leaves', () => {
    // Its own mode stores 2 kW, of which a waiting device needs 1.5 kW.
    const relief = exporting(battery({ signedPowerW: 2000 }), 500);

    expect(relief.decisions.get('battery')).toEqual({ kind: 'setpoint', setpointW: 400, stepW: 5 });
    expect(relief.levers.battery).toMatchObject({ purpose: 'surplus', preClaimSignedW: 2000 });
    expect(relief.batteries[0]).toMatchObject({ claim: 'cap_for_device', setpointW: 400 });
    expect(relief.shed).toEqual({ netCreditKw: 0, relieving: false, drawMarginKw: 0 });
  });

  it('never claims to store more than its own mode does, or for a device already running', () => {
    expect(exporting(battery({ signedPowerW: 1000 }), 1500).decisions.size).toBe(0);
    expect(exporting(battery({ signedPowerW: 2000 }), 500, {}, NOW, 'running').decisions.size).toBe(0);
    expect(exporting(battery({ signedPowerW: 2000 }), 500, {}, NOW, 'none').decisions.size).toBe(0);
  });

  it('never claims a discharging battery, a full one, or one charging from the grid', () => {
    expect(exporting(battery({ signedPowerW: -500 }), 500).decisions.size).toBe(0);
    expect(exporting(battery({ signedPowerW: 2000, chargeCeilingW: 0 }), 500).decisions.size).toBe(0);
    // The house imports more than it charges: none of it is solar.
    const grid = cycle(battery({ signedPowerW: 2000 }), 3, {}, NOW, 3, offer(-3000, 'waiting'));
    expect(grid.decisions.size).toBe(0);
  });

  it('keeps a capped charge steady while the device runs on the rest, and counts it needed', () => {
    const relief = exporting(following(), 500, capped({ lastNeedAtMs: NOW - 60_000 }), NOW, 'running');

    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 400 });
    expect(relief.levers.battery?.lastNeedAtMs).toBe(NOW);
  });

  it('paces a rise like a surplus climb, and withholds the increase from restore', () => {
    const recent = capped({ chargeRaisedAtMs: NOW - 60_000 });
    expect(exporting(following(), 2500, recent, NOW, 'running').decisions.get('battery'))
      .toMatchObject({ setpointW: 400 });

    const due = exporting(following(), 2500, capped({ chargeRaisedAtMs: NOW - SURPLUS_TRACK_STEP_MIN_INTERVAL_MS }), NOW, 'running');
    expect(due.decisions.get('battery')).toMatchObject({ setpointW: 2400 });
    expect(due.levers.battery?.chargeRaisedAtMs).toBe(NOW);
    expect(due.batteries[0]).toMatchObject({ claim: 'raise_charge' });
    // 2 kW more charge than the battery takes now: restore may not spend it.
    expect(due.withheldKw).toBeCloseTo(2);
  });

  it('falls at once when a device takes its share, but not inside the margin it leaves', () => {
    const held = following(1400);
    const justRaised = capped({ setpointW: 1400, chargeRaisedAtMs: NOW });
    expect(exporting(held, 1200, justRaised).decisions.get('battery')).toMatchObject({ setpointW: 1100 });
    expect(exporting(held, 1450, justRaised).decisions.get('battery')).toMatchObject({ setpointW: 1400 });
    expect(exporting(held, 150, justRaised).decisions.get('battery')).toMatchObject({ setpointW: 0 });
  });

  it('keeps a held charge where it is on a deficit, for shedding to decide in priority order', () => {
    const relief = cycle(following(1400), -0.5, capped({ setpointW: 1400 }), NOW, 3, offer(1500, 'waiting'));

    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 1400 });
    expect(relief.shed.netCreditKw).toBe(0);
    expect(relief.levers.battery?.purpose).toBe('surplus');
  });

  it('drops a charge raised past its own mode\'s at once on a deficit, and keeps a cap below it', () => {
    const raised = capped({ setpointW: 2400 });
    const relief = cycle(following(2400), -0.5, raised, NOW, 3, offer(1500, 'running'));
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 2000 });

    const cap = cycle(following(400), -0.5, capped(), NOW, 3, offer(1500, 'waiting'));
    expect(cap.decisions.get('battery')).toMatchObject({ setpointW: 400 });
  });

  it('hands a full battery\'s surplus hold back on a deficit too', () => {
    const full = battery({ signedPowerW: 0, claimHeld: true, chargeCeilingW: 0 });
    expect(cycle(full, -0.5, capped(), NOW, 3).decisions.get('battery')).toEqual({ kind: 'release', reason: 'full' });
  });

  it('hands a surplus hold back after a short dwell once no device needs the cap', () => {
    const quiet = capped({ lastNeedAtMs: NOW - STORAGE_SURPLUS_RELEASE_DWELL_MS + 10_000 });
    expect(exporting(following(), 500, quiet, NOW, 'none').decisions.get('battery')).toMatchObject({ setpointW: 400 });

    const dwelt = capped({ lastNeedAtMs: NOW - STORAGE_SURPLUS_RELEASE_DWELL_MS });
    expect(exporting(following(), 500, dwelt, NOW, 'none').decisions.get('battery'))
      .toEqual({ kind: 'release', reason: 'surplus_dwell' });
    // A charge raised past its own mode's does no device any good: not needed either.
    const raised = capped({ setpointW: 2400, lastNeedAtMs: NOW - STORAGE_SURPLUS_RELEASE_DWELL_MS });
    expect(exporting(following(2400), 2500, raised, NOW, 'running').decisions.get('battery'))
      .toEqual({ kind: 'release', reason: 'surplus_dwell' });
    // A limit hold answers to the restore lane, never to the dwell.
    const limit = { battery: lever({ setpointW: 0, lastNeedAtMs: NOW - STORAGE_SURPLUS_RELEASE_DWELL_MS }) };
    expect(exporting(battery({ claimHeld: true }), 0, limit, NOW, 'none').decisions.get('battery'))
      .toMatchObject({ kind: 'setpoint', setpointW: 0 });
  });

  it('hands a surplus hold back at once when the battery stops taking charge', () => {
    const full = battery({ signedPowerW: 0, claimHeld: true, chargeCeilingW: 0 });
    expect(exporting(full, 500, capped(), NOW, 'running').decisions.get('battery'))
      .toEqual({ kind: 'release', reason: 'full' });
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
    expect(resolveStorageSurplus([ranked], {}, 0)).toEqual({
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
      battery: lever({ setpointW: 1500, purpose: 'surplus' }),
    }, 0)).toEqual({ claimants: [], dischargeW: 0 });
  });

  it('still claims a battery whose Power-limit control is off: it stores spare solar', () => {
    expect(chargeOf(battery({ signedPowerW: 2000, powerLimitControl: false }), {}, 0)).toBe(2000);
  });

  it('never offers a battery\'s own discharge: it is taken out of the export', () => {
    expect(claimed(battery({ signedPowerW: -5000 }), {}, -5000)).toEqual({
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

  it('reads nothing of a battery it cannot read', () => {
    expect(claimed(unreadBattery(), { battery: lever() }, 0)).toEqual({ claimants: [], dischargeW: 0 });
  });
});

describe('a raise past the own mode\'s charge, ranked against the consumers below it', () => {
  /** A battery that follows its hold, at this priority; 5 kW of charge range. */
  const ranked = (id: string, priority: number, overrides: Partial<ObservedStorageInput>): PlanInputDevice => {
    const base = battery({
      range: { minW: -5000, maxW: 5000, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
      chargeCeilingW: 5000,
      ...overrides,
    });
    return { ...base, id, name: id, priority };
  };
  /** A surplus hold raised to `setpointW` past the `ownModeW` its own mode charged when PELS took it. */
  const raised = (setpointW: number, ownModeW: number): StorageLeverState => lever({
    setpointW, purpose: 'surplus', preClaimSignedW: ownModeW, ownModeChargeW: ownModeW,
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
    const offers = resolveSurplusEligibility({
      devices,
      state: createPlanEngineState(),
      signedNetKw: signedNetW / 1000,
      inferredSurplusKw: 0,
      storage: resolveStorageSurplus(devices, levers, signedNetW),
      excludeIds: new Set(),
      getConfig: () => ({ surplusWilling: true, surplusDelta: 2 }),
      nowTs: NOW,
    });
    const relief = decideStorageRelief(
      devices, buildMeasuredPower({ drawKw: signedNetW / 1000, headroomKw: 8 }), levers, offers, NOW,
    );
    const chargeOf = (id: string, observedW: number): number => {
      const decision: StorageDecision | undefined = relief.decisions.get(id);
      return decision?.kind === 'setpoint' ? decision.setpointW : observedW;
    };
    return { upper: chargeOf('upper', 1000), lower: chargeOf('lower', 1000) };
  };

  it('keeps two held batteries and a waiting device above both within the solar that funds them', () => {
    // 3 kW of solar: the upper battery held at 1 kW (its own mode charged 0.5 kW),
    // the lower one at its own mode's 1 kW, and 1 kW exported. The 1.5 kW tank above both waits.
    const devices = [
      tank(),
      ranked('upper', 5, { signedPowerW: 1000, claimHeld: true }),
      ranked('lower', 6, { signedPowerW: 1000 }),
    ];
    const charges = decide(devices, { upper: raised(1000, 500) }, -1000);
    // The tank's 1.5 kW comes out of the batteries, the lower one first: the
    // upper one never raises into the charge the lower one is offered.
    expect(charges.upper).toBe(500);
    expect(charges.lower).toBe(400);
    expect(charges.upper + charges.lower + 1500).toBeLessThanOrEqual(3000);
  });

  it('never raises the upper of two batteries past its own charge and the export, with no device waiting', () => {
    // 0.5 kW exported past two batteries storing 1 kW each; the upper one is held at its own mode's 1 kW.
    const devices = [
      ranked('upper', 5, { signedPowerW: 1000, claimHeld: true }),
      ranked('lower', 6, { signedPowerW: 1000 }),
    ];
    const charges = decide(devices, { upper: raised(1000, 1000) }, -500);
    // Its own 1 kW and the 0.5 kW exported, less half its deadband: never the lower one's 1 kW.
    expect(charges.upper).toBe(1400);
    expect(charges.lower).toBe(1000);
  });

  it('caps a held battery the same, bounded by the consumers below it or not', () => {
    const capped = { battery: lever({ setpointW: 400, purpose: 'surplus', preClaimSignedW: 2000, ownModeChargeW: 2000 }) };
    for (const belowW of [0, 1000]) {
      expect(exporting(battery({ signedPowerW: 400, claimHeld: true }), 500, capped, NOW, 'running').decisions.get('battery'))
        .toMatchObject({ setpointW: 400 });
      expect(cycle(battery({ signedPowerW: 400, claimHeld: true }), 8, capped, NOW, -1.5, offer(500, 'running', belowW))
        .decisions.get('battery')).toMatchObject({ setpointW: 400 });
    }
  });
});

describe('the surplus offer contract', () => {
  it('treats a holdable battery the allocator made no offer to as a broken producer', () => {
    expect(() => cycle(battery({ signedPowerW: 2000 }), 8, {}, NOW, -1.5, new Map()))
      .toThrow('No surplus offer for holdable battery battery');
  });

  it('asks no offer of a battery it may not hold', () => {
    expect(cycle(battery({ signedPowerW: 2000, admissible: false }), 8, {}, NOW, -1.5, new Map()).decisions.size).toBe(0);
  });
});

describe('storage discharge as restore sees it', () => {
  it('takes the held discharge off every headroom axis and leaves the draw measured', () => {
    const power = buildMeasuredPower({ drawKw: 2, headroomKw: 1, capacityHeadroomKw: 1, budgetHeadroomKw: 0.5 });
    const relief = cycle(battery({ signedPowerW: -1500 }), 1, { battery: lever() });

    expect(withoutStorageWithheld(power, relief)).toEqual({
      ...power, headroomKw: -0.5, capacityHeadroomKw: -0.5, budgetHeadroomKw: -1,
    });
  });
});

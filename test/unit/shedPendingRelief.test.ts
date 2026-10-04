import {
  candidatesBeyondPendingRelief,
  holdPendingShedDecision,
  latchShedDecision,
  resolvePendingShedRelief,
  type PendingShedRelief,
} from '../../lib/plan/shedding/pendingRelief';
import type { ShedLatchDecision, ShedPlanLatch } from '../../lib/plan/planState';
import type { MeteredPlanInputDevice, PlanInputDevice } from '../../lib/plan/planTypes';
import type { ShedCandidate, SteppedShedCandidate } from '../../lib/plan/shedding/types';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanInputDevice, steppedInputDevice } from '../utils/planTestUtils';

const NOW = 1_000_000;

// A 1-phase EV charger in amps, 230 W per amp, as on the SHS test Homey.
const chargerProfile: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: '6a', planningPowerW: 1380 },
    { id: '10a', planningPowerW: 2300 },
    { id: '12a', planningPowerW: 2760 },
    { id: '14a', planningPowerW: 3220 },
    { id: '16a', planningPowerW: 3680 },
    { id: '20a', planningPowerW: 4600 },
  ],
};

// 2026-10-01 22:25:17: the charger, drawing 4.541 kW at 20 A, was sent to 14 A
// against a 1.02 kW deficit — 1.321 kW of relief at this profile's 14 A.
const LATCHED_READING_W = 6_336;
const CREDITED_KW = 4.541 - 3.22;

const charger = (overrides: Partial<MeteredPlanInputDevice> = {}): MeteredPlanInputDevice => steppedInputDevice({
  id: 'ev',
  name: 'Elbillader',
  steppedLoadProfile: chargerProfile,
  isEvCharger: true,
  // The charger echoes the new setpoint before its draw moves.
  selectedStepId: '14a',
  currentDrawKw: 4.541,
  ...overrides,
});

/** One device's latched decisions: a single one, unless a case spells more. */
const decided = (creditedKw: number, decidedAtMs = NOW - 3_000): ShedLatchDecision[] => [{ decidedAtMs, creditedKw }];

const chargerLatch = (overrides: Partial<ShedPlanLatch> = {}): ShedPlanLatch => ({
  powerW: LATCHED_READING_W,
  decisions: new Map([['ev', decided(CREDITED_KW)]]),
  stepTargets: new Map([['ev', '14a']]),
  ...overrides,
});

const pendingFor = (
  latch: ShedPlanLatch,
  devices: PlanInputDevice[],
  powerW = 6_378,
): PendingShedRelief => {
  const pending = resolvePendingShedRelief(latch, devices, powerW, NOW);
  if (pending === null) throw new Error('expected relief to be pending');
  return pending;
};

describe('resolvePendingShedRelief', () => {
  it('counts relief a stepped device has not delivered in full, however the reading moves', () => {
    // Three seconds on, the reading is 42 W HIGHER and the charger still draws its 20 A.
    const pending = pendingFor(chargerLatch(), [charger()]);

    expect(pending.undeliveredKw).toBeCloseTo(CREDITED_KW, 6);
    expect(pending.totalKw).toBeCloseTo(CREDITED_KW, 6);
  });

  it('retires a decision once the device has delivered its relief and the reading shows it', () => {
    const pending = pendingFor(chargerLatch(), [charger({ currentDrawKw: 3.07 })], LATCHED_READING_W - 1_400);

    expect(pending.totalKw).toBe(0);
    expect(pending.held.size).toBe(0);
    expect(pending.retained.decisions.size).toBe(0);
    expect(pending.retained.stepTargets.size).toBe(0);
  });

  it('cannot revive a retired decision when the reading rises again', () => {
    const seen = pendingFor(chargerLatch(), [charger({ currentDrawKw: 3.07 })], LATCHED_READING_W - 1_400);

    // A new load lifts the reading above where the shed was decided.
    const lifted = pendingFor(seen.retained, [charger({ currentDrawKw: 3.07 })], LATCHED_READING_W + 500);

    expect(lifted.totalKw).toBe(0);
  });

  it('drops a decision whose rung a profile edit has removed', () => {
    const edited = charger({
      steppedLoadProfile: { steps: chargerProfile.steps.filter((step) => step.id !== '14a') },
      selectedStepId: '16a',
    });

    const pending = pendingFor(chargerLatch(), [edited]);

    expect(pending.held.size).toBe(0);
    expect(pending.totalKw).toBe(0);
  });

  it('reads a charger landed at its rung above nominal mains as delivered', () => {
    // 14 A at 240 V draws 3.36 kW against the rung's 3.22 kW at 230 V. The
    // reading has fallen by the step, so the shed is seen and retired.
    const pending = pendingFor(chargerLatch(), [charger({ currentDrawKw: 3.36 })], LATCHED_READING_W - 1_200);

    expect(pending.undeliveredKw).toBe(0);
    expect(pending.undeliveredKwByDevice.size).toBe(0);
    expect(pending.totalKw).toBe(0);
    expect(pending.held.size).toBe(0);
  });

  it('still counts a charger on the rung above its held one as undelivered, even under low mains', () => {
    // Still at 16 A at 220 V: 3.52 kW, 0.30 kW over 14 A, is the step it has yet
    // to take, past the mains-voltage allowance.
    const pending = pendingFor(chargerLatch(), [charger({ currentDrawKw: 3.52 })], LATCHED_READING_W - 1_200);

    expect(pending.undeliveredKw).toBeCloseTo(3.52 - 3.22, 6);
    expect(pending.held.has('ev')).toBe(true);
  });

  it('keeps the allowance under half the gap to the rung above', () => {
    // A 2 A ladder at 30 A: the rung above is 0.46 kW away, so the allowance is
    // 0.23 kW, not 5% of 6.9 kW. Still at 32 A at 226 V, 7.23 kW, is 0.33 kW
    // over 30 A: a step still to come.
    const wideCharger = charger({
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: '28a', planningPowerW: 6440 },
          { id: '30a', planningPowerW: 6900 },
          { id: '32a', planningPowerW: 7360 },
        ],
      },
      selectedStepId: '30a',
      currentDrawKw: 7.23,
    });
    const latch = chargerLatch({ decisions: new Map([['ev', decided(0.46)]]), stepTargets: new Map([['ev', '30a']]) });

    const pending = pendingFor(latch, [wideCharger], LATCHED_READING_W - 1_200);

    expect(pending.undeliveredKw).toBeCloseTo(7.23 - 6.9, 6);
    expect(pending.held.has('ev')).toBe(true);
  });

  it('gives no mains-voltage allowance to a ladder that is not a charger\'s', () => {
    // A water heater's rungs are watts the owner chose, 0.1 kW apart. Drawing
    // 30 W over its held rung, it has a step still to take.
    const heater = steppedInputDevice({
      id: 'vvb',
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1000 },
          { id: 'mid', planningPowerW: 1100 },
          { id: 'high', planningPowerW: 2000 },
        ],
      },
      selectedStepId: 'mid',
      currentDrawKw: 1.13,
    });
    const latch = chargerLatch({ decisions: new Map([['vvb', decided(0.87)]]), stepTargets: new Map([['vvb', 'mid']]) });

    const pending = pendingFor(latch, [heater]);

    expect(pending.undeliveredKwByDevice.get('vvb')).toBeCloseTo(0.03, 6);
    // Chosen again, it keeps its first stamp: its earlier step has not landed.
    const deeper = {
      shedSet: new Set(['vvb']),
      shedReasons: new Map(),
      shedStepTargets: new Map([['vvb', 'low']]),
      creditedKw: new Map([['vvb', 0.1]]),
    };
    const relatched = latchShedDecision(deeper, pending, 6_378, NOW);
    expect(relatched.decisions.get('vvb')?.map((decision) => decision.decidedAtMs)).toEqual([NOW - 3_000]);
  });

  it('lays the reading\'s fall against the oldest decision first', () => {
    // The charger landed at 14 A and was then sent to 10 A, where it has landed
    // too. The meter has caught up on the 14 A step only: the 10 A step is still
    // to show, in full.
    const latch = chargerLatch({
      decisions: new Map([['ev', [
        { decidedAtMs: NOW - 13_000, creditedKw: CREDITED_KW },
        { decidedAtMs: NOW - 10_000, creditedKw: 0.92 },
      ]]]),
      stepTargets: new Map([['ev', '10a']]),
    });

    const pending = pendingFor(latch, [charger({ selectedStepId: '10a', currentDrawKw: 2.3 })], LATCHED_READING_W - 1_321);

    expect(pending.totalKw).toBeCloseTo(0.92, 6);
    expect(pending.held.get('ev')).toEqual([{ decidedAtMs: NOW - 10_000, creditedKw: 0.92 }]);
  });

  it('does not lay the fall a retired decision claimed against the one still standing', () => {
    // The 14 A step has shown and is retired; the 10 A step has not. The meter
    // then repeats the same reading: the 10 A step is still to show, in full.
    const latch = chargerLatch({
      decisions: new Map([['ev', [
        { decidedAtMs: NOW - 13_000, creditedKw: CREDITED_KW },
        { decidedAtMs: NOW - 10_000, creditedKw: 0.92 },
      ]]]),
      stepTargets: new Map([['ev', '10a']]),
    });
    const landed = [charger({ selectedStepId: '10a', currentDrawKw: 2.3 })];
    const caughtUp = LATCHED_READING_W - 1_321;

    const first = pendingFor(latch, landed, caughtUp);
    const repeated = pendingFor(first.retained, landed, caughtUp);
    const again = pendingFor(repeated.retained, landed, caughtUp);

    expect(first.retained.powerW).toBeCloseTo(caughtUp, 6);
    expect(repeated.totalKw).toBeCloseTo(0.92, 6);
    expect(again.totalKw).toBeCloseTo(0.92, 6);
    expect(again.held.get('ev')).toEqual([{ decidedAtMs: NOW - 10_000, creditedKw: 0.92 }]);
  });

  it('keeps an expired decision\'s claim on the fall while a newer one stands', () => {
    // The 14 A step has left its window unseen; the 10 A step is 10 s old. A
    // fall that shows only the 14 A step is the 14 A step's, so the 10 A step is
    // still credited in full, while the expired one credits nothing.
    const latch = chargerLatch({
      decisions: new Map([['ev', [
        { decidedAtMs: NOW - 31_000, creditedKw: CREDITED_KW },
        { decidedAtMs: NOW - 10_000, creditedKw: 0.92 },
      ]]]),
      stepTargets: new Map([['ev', '10a']]),
    });
    const landed = [charger({ selectedStepId: '10a', currentDrawKw: 2.3 })];

    const unchanged = pendingFor(latch, landed);
    const shown = pendingFor(latch, landed, LATCHED_READING_W - 1_321);

    expect(unchanged.totalKw).toBeCloseTo(0.92, 6);
    expect(unchanged.retained.decisions.get('ev')).toHaveLength(2);
    expect(shown.totalKw).toBeCloseTo(0.92, 6);
    expect(shown.held.get('ev')).toEqual([{ decidedAtMs: NOW - 10_000, creditedKw: 0.92 }]);
  });

  it('drops an expired decision once nothing newer stands', () => {
    const latch = chargerLatch({ decisions: new Map([['ev', decided(CREDITED_KW, NOW - 31_000)]]) });

    const pending = pendingFor(latch, [charger({ currentDrawKw: 3.22 })]);

    expect(pending.retained.decisions.size).toBe(0);
    expect(pending.rebased.size).toBe(0);
  });

  it('keeps the part of delivered relief a lagging reading does not show yet', () => {
    const pending = pendingFor(chargerLatch(), [charger({ currentDrawKw: 3.07 })], LATCHED_READING_W - 400);

    expect(pending.undeliveredKw).toBe(0);
    expect(pending.totalKw).toBeCloseTo(CREDITED_KW - 0.4, 6);
  });

  it('counts a turned-off device that still draws as undelivered', () => {
    const latch = chargerLatch({ decisions: new Map([['heater', decided(1.2)]]), stepTargets: new Map() });
    const heater = buildPlanInputDevice({ id: 'heater', currentDrawKw: 1.2 });

    // The reading has fallen by more than half the credit, for some other reason;
    // the heater's own meter still says its relief is to come.
    const pending = pendingFor(latch, [heater], LATCHED_READING_W - 900);

    expect(pending.totalKw).toBeCloseTo(1.2, 6);
  });

  it('credits only relief the latched decision banked, never an older unconfirmed one', () => {
    // `heater` was re-selected while its earlier turn-off was still unconfirmed,
    // so the pass banked nothing for it.
    const latch = chargerLatch({ decisions: new Map([['ev', decided(CREDITED_KW)], ['heater', decided(0)]]) });
    const heater = buildPlanInputDevice({ id: 'heater', currentDrawKw: 2 });

    const pending = pendingFor(latch, [charger(), heater]);

    expect(pending.totalKw).toBeCloseTo(CREDITED_KW, 6);
    expect(pending.outstandingKw.has('heater')).toBe(false);
    expect(pending.held.has('heater')).toBe(true);
  });

  it('drops a device that has left the snapshot: there is nothing left to read', () => {
    const latch = chargerLatch({ decisions: new Map([['ev', decided(CREDITED_KW)], ['gone', decided(2)]]) });

    const pending = pendingFor(latch, [charger()]);

    expect(pending.held.has('gone')).toBe(false);
    expect(pending.totalKw).toBeCloseTo(CREDITED_KW, 6);
  });

  it('times each decision on its own: an older one leaves the window while a newer one stays', () => {
    const latch = chargerLatch({
      decisions: new Map([['ev', decided(CREDITED_KW, NOW - 30_000)], ['heater', decided(1.2, NOW - 5_000)]]),
    });
    const heater = buildPlanInputDevice({ id: 'heater', currentDrawKw: 1.2 });

    const pending = pendingFor(latch, [charger(), heater]);

    expect([...pending.held.keys()]).toEqual(['heater']);
    expect(pending.totalKw).toBeCloseTo(1.2, 6);
  });

  it('holds nothing outside the window', () => {
    const latch = chargerLatch({ decisions: new Map([['ev', decided(CREDITED_KW, NOW - 30_000)]]) });

    const pending = pendingFor(latch, [charger()]);

    expect(pending.held.size).toBe(0);
    expect(pending.totalKw).toBe(0);
  });

  it('answers nothing without a latch or without watts on the sample', () => {
    expect(resolvePendingShedRelief(null, [charger()], 6_378, NOW)).toBeNull();
    expect(resolvePendingShedRelief(chargerLatch(), [charger()], null, NOW)).toBeNull();
  });
});

describe('latchShedDecision', () => {
  const selection = (deviceId: string, creditedKw: number, stepId?: string) => ({
    shedSet: new Set([deviceId]),
    shedReasons: new Map(),
    shedStepTargets: new Map(stepId === undefined ? [] : [[deviceId, stepId]]),
    creditedKw: new Map([[deviceId, creditedKw]]),
  });

  it('carries held decisions on their own stamps, with what is still outstanding', () => {
    const pending = pendingFor(chargerLatch(), [charger(), buildPlanInputDevice({ id: 'bath', currentDrawKw: 1.14 })]);

    const latch = latchShedDecision(selection('bath', 1.14), pending, 6_378, NOW);

    expect(latch.decisions.get('ev')).toEqual([{ decidedAtMs: NOW - 3_000, creditedKw: pending.outstandingKw.get('ev') }]);
    expect(latch.decisions.get('bath')).toEqual([{ decidedAtMs: NOW, creditedKw: 1.14 }]);
    expect(latch.stepTargets.get('ev')).toBe('14a');
    expect(latch.powerW).toBe(6_378);
  });

  it('keeps the first stamp of a held device chosen again before it has moved', () => {
    // Still drawing its 20 A: a stuck command must not be renewed one rung at a time.
    const pending = pendingFor(chargerLatch(), [charger()]);

    const latch = latchShedDecision(selection('ev', 0.92, '10a'), pending, 6_378, NOW);

    expect(latch.decisions.get('ev')).toEqual([{ decidedAtMs: NOW - 3_000, creditedKw: CREDITED_KW + 0.92 }]);
    expect(latch.stepTargets.get('ev')).toBe('10a');
  });

  it('gives a held device chosen again once it has delivered a decision of its own', () => {
    // Landed at 14 A; the reading has not caught up yet, so it is still held.
    const pending = pendingFor(chargerLatch(), [charger({ currentDrawKw: 3.22 })]);
    expect(pending.outstandingKw.get('ev')).toBeCloseTo(CREDITED_KW, 6);

    const latch = latchShedDecision(selection('ev', 0.92, '10a'), pending, 6_378, NOW);

    // The 14 A step keeps its own decision and stamp: re-dated, it would be
    // credited for a fresh 30 s against a reading a rising load keeps from
    // showing it.
    expect(latch.decisions.get('ev')).toEqual([
      { decidedAtMs: NOW - 3_000, creditedKw: pending.outstandingKw.get('ev') },
      { decidedAtMs: NOW, creditedKw: 0.92 },
    ]);
    expect(latch.stepTargets.get('ev')).toBe('10a');
  });

  it('gives a charger landed at its rung above nominal mains a new decision when chosen again', () => {
    // 14 A at 240 V: 3.36 kW against the 3.22 kW rung, and nothing left to deliver.
    const pending = pendingFor(chargerLatch(), [charger({ currentDrawKw: 3.36 })]);

    const latch = latchShedDecision(selection('ev', 0.92, '10a'), pending, 6_378, NOW);

    expect(latch.decisions.get('ev')?.map((decision) => decision.decidedAtMs)).toEqual([NOW - 3_000, NOW]);
  });

  it('does not credit an expired step twice when its stuck charger is priced again from its meter', () => {
    // 35 s ago the charger was sent 32 A -> 16 A and echoed 16 A, but still draws
    // its 32 A. That step has expired; a residual shed of the heater 15 s ago
    // still stands, so the step stays in the latch as a claim on the fall.
    const ladder: SteppedLoadProfile = {
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: '6a', planningPowerW: 1380 },
        { id: '16a', planningPowerW: 3680 },
        { id: '32a', planningPowerW: 7360 },
      ],
    };
    const stuck = charger({ steppedLoadProfile: ladder, selectedStepId: '16a', currentDrawKw: 7.36 });
    const heaterOff = buildPlanInputDevice({ id: 'heater', currentDrawKw: 0 });
    const latch = chargerLatch({
      decisions: new Map([['ev', decided(3.68, NOW - 35_000)], ['heater', decided(0.5, NOW - 15_000)]]),
      stepTargets: new Map([['ev', '16a']]),
    });
    const pending = pendingFor(latch, [stuck, heaterOff], LATCHED_READING_W);

    // Not held, so the charger is priced from its meter: 7.36 kW -> 6 A frees 5.98 kW.
    const relatched = latchShedDecision(selection('ev', 5.98, '6a'), pending, LATCHED_READING_W, NOW);

    // Its expired step's watts are all in that 5.98 kW: it keeps no claim.
    expect(relatched.decisions.get('ev')).toEqual([{ decidedAtMs: NOW, creditedKw: 5.98 }]);
    // The charger lands at 6 A and the reading falls by the 5.98 kW: both
    // decisions have shown, and nothing is left credited.
    const landed = resolvePendingShedRelief(
      relatched,
      [charger({ steppedLoadProfile: ladder, selectedStepId: '6a', currentDrawKw: 1.38 }), heaterOff],
      LATCHED_READING_W - 5_980,
      NOW + 10_000,
    );
    expect(landed?.totalKw).toBe(0);
    expect(landed?.held.size).toBe(0);
  });

  it('drops the carried rung of a held device chosen again for a binary off', () => {
    const pending = pendingFor(chargerLatch(), [charger()]);

    const latch = latchShedDecision(selection('ev', 1.38), pending, 6_378, NOW);

    expect(latch.stepTargets.has('ev')).toBe(false);
  });
});

const steppedCandidate = (
  deviceOverrides: Partial<MeteredPlanInputDevice> = {},
  overrides: Partial<Pick<SteppedShedCandidate, 'fromStepId' | 'rungs'>> = {},
): SteppedShedCandidate => {
  const device = charger(deviceOverrides);
  const measuredKw = device.currentDrawKw;
  return {
    ...device,
    kind: 'stepped',
    priority: 1,
    recentlyRestored: false,
    unconfirmedRelief: false,
    fromStepId: '14a',
    // Priced from the meter, as the candidate builder prices any descent.
    rungs: [
      { toStepId: '12a', reliefKw: measuredKw - 2.76 },
      { toStepId: '10a', reliefKw: measuredKw - 2.3 },
      { toStepId: '6a', reliefKw: measuredKw - 1.38 },
    ],
    effectivePower: measuredKw - 1.38,
    preemptiveStepDown: true,
    ...overrides,
  } as SteppedShedCandidate;
};

const binaryCandidate = (id: string, kw: number): ShedCandidate => ({
  ...buildPlanInputDevice({ id, currentDrawKw: kw }),
  kind: 'binary',
  priority: 2,
  recentlyRestored: false,
  unconfirmedRelief: false,
  effectivePower: kw,
} as ShedCandidate);

describe('candidatesBeyondPendingRelief', () => {
  it('prices a held charger below its rung net of the relief already credited', () => {
    const [beyond] = candidatesBeyondPendingRelief([steppedCandidate()], pendingFor(chargerLatch(), [charger()]));

    if (beyond?.kind !== 'stepped') throw new Error('expected the charger to stay a stepped candidate');
    expect(beyond.fromStepId).toBe('14a');
    expect(beyond.rungs.map((rung) => rung.toStepId)).toEqual(['12a', '10a', '6a']);
    // 14 A -> 12 A frees 0.46 kW, not the 1.78 kW the meter alone would say.
    expect(beyond.rungs[0].reliefKw).toBeCloseTo(0.46, 6);
    expect(beyond.effectivePower).toBeCloseTo(3.22 - 1.38, 6);
    expect(beyond.unconfirmedRelief).toBe(false);
  });

  it('prices a deeper rung for a charger landed above nominal mains at the nameplate step', () => {
    // 14 A at 240 V draws 3.36 kW, and 12 A at 240 V will draw 2.88 kW: only the
    // 0.46 kW nameplate step is sure to go, not the 0.60 kW the meter suggests.
    const landed = { selectedStepId: '14a', currentDrawKw: 3.36 } as const;

    const [beyond] = candidatesBeyondPendingRelief(
      [steppedCandidate(landed)],
      pendingFor(chargerLatch(), [charger(landed)]),
    );

    if (beyond?.kind !== 'stepped') throw new Error('expected the charger to stay a stepped candidate');
    expect(beyond.rungs[0].reliefKw).toBeCloseTo(3.22 - 2.76, 6);
  });

  it('drops rungs at or above the held one when the charger still reports its old step', () => {
    // No echo: the charger still reports 20 A, so its ladder starts above 14 A.
    const candidate = steppedCandidate({ selectedStepId: '20a' }, {
      fromStepId: '20a',
      rungs: [
        { toStepId: '16a', reliefKw: 4.541 - 3.68 },
        { toStepId: '14a', reliefKw: 4.541 - 3.22 },
        { toStepId: '12a', reliefKw: 4.541 - 2.76 },
      ],
    });

    const [beyond] = candidatesBeyondPendingRelief([candidate], pendingFor(chargerLatch(), [charger()]));

    if (beyond?.kind !== 'stepped') throw new Error('expected the charger to stay a stepped candidate');
    expect(beyond.rungs.map((rung) => rung.toStepId)).toEqual(['12a']);
    expect(beyond.rungs[0].reliefKw).toBeCloseTo(0.46, 6);
  });

  it('offers nothing deeper for a held step-down that banked nothing', () => {
    const latch = chargerLatch({ decisions: new Map([['ev', decided(0)]]) });

    expect(candidatesBeyondPendingRelief([steppedCandidate()], pendingFor(latch, [charger()]))).toEqual([]);
  });

  it('offers nothing more for a held binary device and passes others through', () => {
    const latch = chargerLatch({ decisions: new Map([['heater', decided(1.2)]]), stepTargets: new Map() });
    const devices = [buildPlanInputDevice({ id: 'heater', currentDrawKw: 1.2 })];

    const others = candidatesBeyondPendingRelief(
      [binaryCandidate('heater', 1.2), binaryCandidate('bath', 1.14)],
      pendingFor(latch, devices),
    );

    expect(others.map((candidate) => candidate.id)).toEqual(['bath']);
  });
});

describe('holdPendingShedDecision', () => {
  const reason = { code: PLAN_REASON_CODES.capacity } as const;

  it('keeps a held charger at the rung it was sent to', () => {
    const held = holdPendingShedDecision([steppedCandidate()], pendingFor(chargerLatch(), [charger()]), reason);

    expect([...held.shedSet]).toEqual(['ev']);
    expect(held.shedStepTargets.get('ev')).toBe('14a');
  });

  it('keeps a charger at its own step when it already sits below the decided rung', () => {
    const candidate = steppedCandidate({ selectedStepId: '12a' }, { fromStepId: '12a' });

    const held = holdPendingShedDecision([candidate], pendingFor(chargerLatch(), [charger()]), reason);

    expect(held.shedStepTargets.get('ev')).toBe('12a');
  });

  it('re-asserts only the held decisions', () => {
    const held = holdPendingShedDecision(
      [steppedCandidate(), binaryCandidate('bath', 1.14)],
      pendingFor(chargerLatch(), [charger()]),
      reason,
    );

    expect([...held.shedSet]).toEqual(['ev']);
  });
});

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
  // The charger echoes the new setpoint before its draw moves.
  selectedStepId: '14a',
  currentDrawKw: 4.541,
  ...overrides,
});

const decided = (creditedKw: number, decidedAtMs = NOW - 3_000): ShedLatchDecision => ({ decidedAtMs, creditedKw });

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

    expect(latch.decisions.get('ev')).toEqual({ decidedAtMs: NOW - 3_000, creditedKw: pending.outstandingKw.get('ev') });
    expect(latch.decisions.get('bath')).toEqual({ decidedAtMs: NOW, creditedKw: 1.14 });
    expect(latch.stepTargets.get('ev')).toBe('14a');
    expect(latch.powerW).toBe(6_378);
  });

  it('keeps the first stamp of a held device chosen again before it has moved', () => {
    // Still drawing its 20 A: a stuck command must not be renewed one rung at a time.
    const pending = pendingFor(chargerLatch(), [charger()]);

    const latch = latchShedDecision(selection('ev', 0.92, '10a'), pending, 6_378, NOW);

    expect(latch.decisions.get('ev')).toEqual({ decidedAtMs: NOW - 3_000, creditedKw: CREDITED_KW + 0.92 });
    expect(latch.stepTargets.get('ev')).toBe('10a');
  });

  it('restamps a held device chosen again once it has delivered its earlier step', () => {
    // Landed at 14 A; the reading has not caught up yet, so it is still held.
    const pending = pendingFor(chargerLatch(), [charger({ currentDrawKw: 3.22 })]);

    const latch = latchShedDecision(selection('ev', 0.92, '10a'), pending, 6_378, NOW);

    expect(latch.decisions.get('ev')?.decidedAtMs).toBe(NOW);
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

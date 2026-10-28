import { writeFileSync } from 'node:fs';
import { OvershootIncident } from '../../lib/plan/overshootIncident';
import { buildPlanContext, buildPlanLimits, resolveMeasuredPower } from '../../lib/plan/planContext';
import { NO_STORAGE_SHED_TERM } from '../../lib/plan/shedding/types';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import {
  dailyOnlyGracePolicy,
  forecastGuardedGracePolicy,
  referenceGracePolicy,
  runSlowResponseSimulation,
  type SimulatedPressurePolicyFactory,
  type SimulatedPressureReading,
  type SlowResponseScenario,
} from '../helpers/slowResponseSimulation';

const SHIPPED = referenceGracePolicy(false);
const ORIGINAL_PROPOSAL = referenceGracePolicy(true);
const RUNTIME_CANDIDATE: SimulatedPressurePolicyFactory = () => {
  const incident = new OvershootIncident();
  return (reading) => {
    const settings = {
      ...reading.settings, capacityEnabled: true,
      gridImportLimitKw: reading.gridTargetKw === null ? null : reading.gridTargetKw / 0.95,
    };
    const devices = [buildPlanInputDevice({ id: 'managed', currentDrawKw: reading.managedKw })];
    const tracker = {
      lastTimestamp: reading.atMs, lastPowerW: reading.powerKw * 1000,
      buckets: { [new Date(Math.floor(reading.atMs / 3_600_000) * 3_600_000).toISOString()]: reading.usedKWh },
      capacityQuarter: {
        startMs: reading.periodStartMs, energyKWh: reading.usedKWh,
        trackedMs: settings.periodMinutes * 60_000 - reading.periodRemainingMs,
      },
    };
    const daily = reading.dailyPaceKw === null ? null : {
      dailySoftLimitKw: reading.dailyPaceKw, budgetPaceKw: reading.dailyPaceKw, projectedExemptKw: 0,
    };
    const context = buildPlanContext(
      devices, settings, tracker, buildPlanLimits(settings, reading.capacityPaceKw, daily), new Map(), reading.atMs,
    );
    const power = resolveMeasuredPower({
      isMeasured: true, totalKw: reading.powerKw, lastPowerUpdateMs: reading.atMs,
      headroomKw: (limitKw) => limitKw - reading.powerKw,
    }, context, devices);
    return incident.decidePacing(context, power, settings, NO_STORAGE_SHED_TERM, reading.shortfallThresholdKw, {
      atMs: reading.atMs, powerW: reading.powerKw * 1000,
    });
  };
};
const POLICIES: Readonly<Record<string, SimulatedPressurePolicyFactory>> = {
  shipped: SHIPPED,
  originalProposal: ORIGINAL_PROPOSAL,
  forecastGuardedProposal: forecastGuardedGracePolicy,
  dailyOnlyProposal: dailyOnlyGracePolicy,
  runtimeCandidate: RUNTIME_CANDIDATE,
};
const SETTINGS = { limitKw: 10, marginKw: 0.1, periodMinutes: 60 } as const;

function scenario(overrides: Partial<SlowResponseScenario>): SlowResponseScenario {
  return {
    id: 'six-kw-start-mid-period',
    settings: SETTINGS,
    startSecond: 1800,
    durationSeconds: 1800,
    usedBeforeKWh: 4,
    managedKw: 6,
    background: [{ atSecond: 0, kw: 8 }],
    meterCadenceSeconds: 10,
    response: { kind: 'delayed', seconds: 30, remainingFraction: 0 },
    gridTargetKw: null,
    dailyPaceKw: null,
    ...overrides,
  };
}

const LAST_TWO_MINUTES = scenario({
  id: 'six-kw-last-two-minutes',
  startSecond: 3480,
  durationSeconds: 120,
  usedBeforeKWh: 9.82,
  background: [{ atSecond: 0, kw: 2 }],
  meterCadenceSeconds: 30,
  response: { kind: 'delayed', seconds: 45, remainingFraction: 0 },
});

const SECOND_BACKGROUND_LOAD = scenario({
  id: 'second-background-load-during-grace',
  startSecond: 3360,
  durationSeconds: 240,
  usedBeforeKWh: 9.4,
  background: [{ atSecond: 0, kw: 2 }, { atSecond: 20, kw: 8 }],
  response: { kind: 'delayed', seconds: 45, remainingFraction: 0 },
});

const DAILY_THEN_CAPACITY_PRESSURE = scenario({
  id: 'daily-grace-before-second-background-load',
  startSecond: 3360,
  durationSeconds: 240,
  usedBeforeKWh: 9.36,
  dailyPaceKw: 6,
  background: [{ atSecond: 0, kw: 2 }, { atSecond: 20, kw: 8 }],
  response: { kind: 'delayed', seconds: 70, remainingFraction: 0 },
});

const HOURLY_MARGIN_200_WH = { ...SETTINGS, marginKw: 0.2 };
const MARGIN_200_WH_NET_HEADROOM = scenario({
  ...LAST_TWO_MINUTES,
  id: 'hourly-200wh-margin-same-net-headroom',
  settings: HOURLY_MARGIN_200_WH,
  usedBeforeKWh: 9.72,
});
const MARGIN_200_WH_SLOW_RESPONSE = scenario({
  ...DAILY_THEN_CAPACITY_PRESSURE,
  id: 'hourly-200wh-margin-long-response',
  settings: HOURLY_MARGIN_200_WH,
  usedBeforeKWh: 9.26,
  response: { kind: 'delayed', seconds: 130, remainingFraction: 0 },
});

const AFFORDABLE_CAPACITY_SPIKE = scenario({
  id: 'affordable-capacity-background-spike',
  managedKw: 2,
  usedBeforeKWh: 4.9,
  background: [{ atSecond: 0, kw: 8.06 }, { atSecond: 20, kw: 2 }],
});

const QUARTER_OCCUPIED_MARGIN = scenario({
  id: 'quarter-margin-already-occupied',
  settings: { ...HOURLY_MARGIN_200_WH, periodMinutes: 15 },
  startSecond: 720,
  durationSeconds: 180,
  usedBeforeKWh: 2,
  managedKw: 6,
  background: [{ atSecond: 0, kw: 3.9 }, { atSecond: 10, kw: 9.9 }],
  meterCadenceSeconds: 10,
  response: { kind: 'delayed', seconds: 10, remainingFraction: 0 },
});

const SCENARIOS: SlowResponseScenario[] = [
  QUARTER_OCCUPIED_MARGIN,
  AFFORDABLE_CAPACITY_SPIKE,
  { ...AFFORDABLE_CAPACITY_SPIKE, id: 'restart-during-capacity-spike', controllerWarmStart: false },
  SECOND_BACKGROUND_LOAD,
  DAILY_THEN_CAPACITY_PRESSURE,
  scenario({
    ...LAST_TWO_MINUTES,
    id: 'hourly-200wh-margin-same-actual-state',
    settings: HOURLY_MARGIN_200_WH,
  }),
  MARGIN_200_WH_NET_HEADROOM,
  scenario({
    ...MARGIN_200_WH_NET_HEADROOM,
    id: 'hourly-200wh-margin-60s-readings',
    meterCadenceSeconds: 60,
  }),
  scenario({
    ...MARGIN_200_WH_SLOW_RESPONSE,
    id: 'hourly-200wh-margin-70s-response',
    response: { kind: 'delayed', seconds: 70, remainingFraction: 0 },
  }),
  MARGIN_200_WH_SLOW_RESPONSE,
  ...[10, 30, 60].map((cadence) => scenario({
    ...LAST_TWO_MINUTES,
    id: `boundary-6kw-cadence-${cadence}s`,
    meterCadenceSeconds: cadence,
  })),
  ...[0, 30, 120].map((delay) => scenario({
    id: `mid-period-6kw-relief-${delay}s`,
    response: { kind: 'delayed', seconds: delay, remainingFraction: 0 },
  })),
  scenario({ id: 'mid-period-no-relief', response: { kind: 'no_relief' } }),
  scenario({
    id: 'short-background-spike',
    managedKw: 2,
    usedBeforeKWh: 4.9,
    background: [{ atSecond: 0, kw: 8.1 }, { atSecond: 20, kw: 2 }],
  }),
  scenario({
    id: 'daily-only-background-spike',
    managedKw: 2,
    usedBeforeKWh: 4,
    dailyPaceKw: 6,
    background: [{ atSecond: 0, kw: 6 }, { atSecond: 20, kw: 2 }],
  }),
  scenario({
    id: 'daily-only-sustained-pressure',
    managedKw: 2,
    usedBeforeKWh: 4,
    dailyPaceKw: 6,
    background: [{ atSecond: 0, kw: 6 }],
  }),
  scenario({
    id: 'repeated-background-pulses',
    managedKw: 2,
    usedBeforeKWh: 4.9,
    background: Array.from({ length: 12 }, (_, index) => ({
      atSecond: index * 20,
      kw: index % 2 === 0 ? 10 : 2,
    })),
  }),
  scenario({
    id: 'falling-background-deficit',
    usedBeforeKWh: 4.9,
    background: [{ atSecond: 0, kw: 10 }, { atSecond: 20, kw: 5 }, { atSecond: 50, kw: 2 }],
  }),
  scenario({
    ...LAST_TWO_MINUTES,
    id: 'no-relief-across-rollover',
    durationSeconds: 180,
    response: { kind: 'no_relief' },
  }),
  scenario({
    ...LAST_TWO_MINUTES,
    id: 'exhausted-period',
    usedBeforeKWh: 9.9,
  }),
  scenario({ id: 'grid-breach', gridTargetKw: 12 }),
  scenario({
    ...LAST_TWO_MINUTES,
    id: 'quarter-last-two-minutes',
    settings: { ...SETTINGS, periodMinutes: 15 },
    startSecond: 780,
    usedBeforeKWh: 2.32,
  }),
];

describe('slow response pressure-policy simulation', () => {
  it('pins the frozen reference outputs independently of later runtime changes', () => {
    const times = [0, 10_000, 30_000, 60_000, 70_000, 80_000];
    const headroom = [-1, -2, -0.1, -0.1, 1, -1];
    for (const universal of [false, true]) {
      const reference = referenceGracePolicy(universal)();
      times.forEach((atMs, index) => {
        const reading: SimulatedPressureReading = {
          atMs, settings: SETTINGS, managedKw: 6, usedKWh: 0,
          powerKw: 10 - headroom[index]!,
          capacityPaceKw: 10,
          dailyPaceKw: null,
          remainingKWh: 2,
          shortfallThresholdKw: 20,
          gridTargetKw: null,
          periodStartMs: 0,
          periodRemainingMs: 1_800_000 - atMs,
        };
        expect(reference(reading).shedActionable).toBe(
          universal ? [false, false, false, true, false, false][index] : [true, true, true, true, false, true][index],
        );
      });
    }
  });

  it('exposes a nominal one-second grace that loses a safe period through sample cadence and response delay', () => {
    const shipped = runSlowResponseSimulation(LAST_TWO_MINUTES, SHIPPED);
    const proposal = runSlowResponseSimulation(LAST_TWO_MINUTES, ORIGINAL_PROPOSAL);
    const guarded = runSlowResponseSimulation(LAST_TWO_MINUTES, forecastGuardedGracePolicy);

    expect(shipped.firstShedSecond).toBe(0);
    expect(shipped.firstReliefSecond).toBe(45);
    expect(shipped.importedWh).toBeCloseTo(141.666667, 5);
    expect(shipped.periods[0]!.usedKWh).toBeCloseTo(9.961667, 5);
    expect(shipped.periods[0]!.aboveHardCapWh).toBe(0);
    expect(proposal.firstShedSecond).toBe(30);
    expect(proposal.firstReliefSecond).toBe(75);
    expect(proposal.importedWh - shipped.importedWh).toBeCloseTo(50, 5);
    expect(proposal.periods[0]!.aboveHardCapWh).toBeCloseTo(11.666667, 5);
    expect(guarded).toEqual(shipped);
    expect(runSlowResponseSimulation(LAST_TWO_MINUTES, dailyOnlyGracePolicy)).toEqual(shipped);
  });

  it('falsifies the projected-breach guard when another background load starts during the first response delay', () => {
    const shipped = runSlowResponseSimulation(SECOND_BACKGROUND_LOAD, SHIPPED);
    const guarded = runSlowResponseSimulation(SECOND_BACKGROUND_LOAD, forecastGuardedGracePolicy);
    const dailyOnly = runSlowResponseSimulation(SECOND_BACKGROUND_LOAD, dailyOnlyGracePolicy);

    expect(shipped.firstShedSecond).toBe(0);
    expect(shipped.firstReliefSecond).toBe(45);
    expect(shipped.importedWh).toBeCloseTo(575, 6);
    expect(shipped.periods[0]!.aboveHardCapWh).toBe(0);
    expect(guarded.firstShedSecond).toBe(20);
    expect(guarded.firstReliefSecond).toBe(65);
    expect(guarded.importedWh).toBeCloseTo(608.333333, 5);
    expect(guarded.periods[0]!.aboveHardCapWh).toBeCloseTo(8.333333, 5);
    expect(dailyOnly).toEqual(shipped);
  });

  it('retains the 6 kW physical draw when command acceptance delivers no relief, and splits energy at rollover', () => {
    const input = scenario({
      ...LAST_TWO_MINUTES,
      durationSeconds: 180,
      response: { kind: 'no_relief' },
    });
    const result = runSlowResponseSimulation(input, SHIPPED);

    expect(result.firstShedSecond).toBe(0);
    expect(result.firstReliefSecond).toBeNull();
    expect(result.commandCount).toBe(1);
    expect(result.managedWh).toBeCloseTo(300, 8);
    expect(result.importedWh).toBeCloseTo(400, 8);
    expect(result.periods).toHaveLength(2);
    expect(result.periods[0]!.usedKWh).toBeCloseTo(9.82 + 8 * 120 / 3600, 8);
    expect(result.periods[1]!.usedKWh).toBeCloseTo(8 * 60 / 3600, 8);
  });

  it('exposes the remaining capacity-resilience trade even when grace is confined to daily-only pressure', () => {
    const shipped = runSlowResponseSimulation(DAILY_THEN_CAPACITY_PRESSURE, SHIPPED);
    const dailyOnly = runSlowResponseSimulation(DAILY_THEN_CAPACITY_PRESSURE, dailyOnlyGracePolicy);
    expect(shipped.firstShedSecond).toBe(0);
    expect(shipped.firstReliefSecond).toBe(70);
    expect(shipped.importedWh).toBeCloseTo(616.666667, 5);
    expect(shipped.periods[0]!.aboveHardCapWh).toBe(0);
    expect(dailyOnly.firstShedSecond).toBe(20);
    expect(dailyOnly.firstReliefSecond).toBe(90);
    expect(dailyOnly.importedWh).toBeCloseTo(650, 5);
    expect(dailyOnly.periods[0]!.aboveHardCapWh).toBeCloseTo(10, 5);
  });

  it('shows a 200 Wh hourly margin absorbing the earlier boundary delays', () => {
    const sameActual = SCENARIOS.find((entry) => entry.id === 'hourly-200wh-margin-same-actual-state')!;
    // Increasing the margin puts the unchanged actual state past the operating
    // allowance, so the existing exhausted-period directive answers immediately.
    for (const policy of Object.values(POLICIES)) {
      const result = runSlowResponseSimulation(sameActual, policy);
      expect(result.firstShedSecond).toBe(0);
      expect(result.periods[0]!.aboveHardCapWh).toBe(0);
    }
    for (const cadence of [30, 60]) {
      const result = runSlowResponseSimulation({
        ...MARGIN_200_WH_NET_HEADROOM, meterCadenceSeconds: cadence,
      }, ORIGINAL_PROPOSAL);
      expect(result.firstShedSecond).toBe(cadence);
      expect(result.importedWh).toBeCloseTo(cadence === 30 ? 191.666667 : 241.666667, 5);
      expect(result.periods[0]!.aboveHardCapWh).toBe(0);
    }
  });

  it('distinguishes a covered response from a long response that consumes most of a 200 Wh margin', () => {
    const covered = SCENARIOS.find((entry) => entry.id === 'hourly-200wh-margin-70s-response')!;
    const coveredResult = runSlowResponseSimulation(covered, dailyOnlyGracePolicy);
    expect(coveredResult.importedWh).toBeCloseTo(650, 6);
    expect(coveredResult.periods[0]!.aboveHardCapWh).toBe(0);
    const shipped = runSlowResponseSimulation(MARGIN_200_WH_SLOW_RESPONSE, SHIPPED);
    const delayed = runSlowResponseSimulation(MARGIN_200_WH_SLOW_RESPONSE, dailyOnlyGracePolicy);
    expect(shipped.importedWh).toBeCloseTo(716.666667, 5);
    expect(shipped.periods[0]!.aboveHardCapWh).toBe(0);
    expect(delayed.importedWh).toBeCloseTo(750, 6);
    expect(delayed.periods[0]!.aboveHardCapWh).toBeCloseTo(10, 6);
  });

  it('avoids a demand restriction on an affordable background spike, while urgent bypasses still act', () => {
    const input = SCENARIOS.find((entry) => entry.id === 'short-background-spike')!;
    expect(runSlowResponseSimulation(input, SHIPPED).commandCount).toBe(1);
    expect(runSlowResponseSimulation(input, ORIGINAL_PROPOSAL).commandCount).toBe(0);
    expect(runSlowResponseSimulation(input, forecastGuardedGracePolicy).commandCount).toBe(0);
    for (const id of ['grid-breach', 'exhausted-period']) {
      const urgent = SCENARIOS.find((entry) => entry.id === id)!;
      for (const policy of Object.values(POLICIES)) {
        expect(runSlowResponseSimulation(urgent, policy).firstShedSecond).toBe(0);
      }
    }
  });

  it('adds patience only for daily-only pressure and still answers a sustained daily deficit', () => {
    const spike = SCENARIOS.find((entry) => entry.id === 'daily-only-background-spike')!;
    expect(runSlowResponseSimulation(spike, SHIPPED).commandCount).toBe(1);
    expect(runSlowResponseSimulation(spike, dailyOnlyGracePolicy).commandCount).toBe(0);
    const sustained = SCENARIOS.find((entry) => entry.id === 'daily-only-sustained-pressure')!;
    expect(runSlowResponseSimulation(sustained, dailyOnlyGracePolicy).firstShedSecond).toBe(60);
  });

  it('does not add waiting during the existing end-of-hour drain or urgent pressure', () => {
    for (const input of [LAST_TWO_MINUTES, SECOND_BACKGROUND_LOAD, DAILY_THEN_CAPACITY_PRESSURE, MARGIN_200_WH_SLOW_RESPONSE]) {
      expect(runSlowResponseSimulation(input, RUNTIME_CANDIDATE)).toEqual(runSlowResponseSimulation(input, SHIPPED));
    }
  });

  it('refuses a quarter wait when the measured trajectory already occupies the margin', () => {
    const shipped = runSlowResponseSimulation(QUARTER_OCCUPIED_MARGIN, SHIPPED);
    const projectedOnly = runSlowResponseSimulation(QUARTER_OCCUPIED_MARGIN, forecastGuardedGracePolicy);
    const runtime = runSlowResponseSimulation(QUARTER_OCCUPIED_MARGIN, RUNTIME_CANDIDATE);
    expect(shipped.importedWh).toBeCloseTo(495, 6);
    expect(shipped.periods[0]!.aboveHardCapWh).toBe(0);
    expect(projectedOnly.importedWh).toBeCloseTo(511.666667, 5);
    expect(projectedOnly.periods[0]!.aboveHardCapWh).toBeCloseTo(11.666667, 5);
    expect(runtime).toEqual(shipped);
  });

  it('prevents a brief capacity spike from restricting a slow device after the controller is warm', () => {
    const input = AFFORDABLE_CAPACITY_SPIKE;
    expect(runSlowResponseSimulation(input, RUNTIME_CANDIDATE).commandCount).toBe(0);
    expect(runSlowResponseSimulation({ ...input, controllerWarmStart: false }, RUNTIME_CANDIDATE).firstShedSecond).toBe(0);
  });

  it('exports reproducible evidence for every policy without asserting the candidate is universally safe', () => {
    const evidence = SCENARIOS.map((input) => ({
      scenario: input,
      results: Object.fromEntries(Object.entries(POLICIES).map(([name, create]) => [
        name, runSlowResponseSimulation(input, create),
      ])),
    }));
    expect(evidence).toHaveLength(SCENARIOS.length);
    const output = process.env.PELS_SLOW_RESPONSE_SIMULATION_OUTPUT;
    if (output) writeFileSync(output, `${JSON.stringify({
      referenceCommit: '172819beebf318ee3a3d8e4dd4cb57982997d75c',
      assumptions: [
        'One managed load, one shed command, no restores or priority selection.',
        'Shipped comparison has no open activation attempt; an open attempt can also give shipped behavior grace.',
        'One-second plant integration; exact cumulative energy at meter samples.',
        'Response delay describes electrical relief, not capability confirmation.',
        'Guarded and daily-only proposals are frozen test-only references; runtime uses its period-margin allowance.',
        'Warm controllers receive equally primed calm observations before the pressure scenario; restart cases omit them.',
        'Runtime grace is estimated discretionary exposure, not a guarantee against unseen loads or late observations.',
      ],
      evidence,
    }, null, 2)}\n`);
  });
});

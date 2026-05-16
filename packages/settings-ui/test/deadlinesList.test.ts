import { describe, expect, it } from 'vitest';
import { testExports } from '../src/ui/deadlinesList.ts';
import type {
  DeferredObjectiveActivePlansV1,
  DeferredObjectiveActivePlanV1,
} from '../../contracts/src/deferredObjectiveActivePlans.ts';
import type {
  DeferredObjectiveSettingsV1,
  DeferredObjectiveSettingsEntry,
} from '../../contracts/src/deferredObjectiveSettings.ts';
import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';

const { resolveDeadlinesListCards, resolveDeadlinesHistoryEntries } = testExports;

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 4, 11, 0, 0, 0);

const buildPlan = (overrides: Partial<DeferredObjectiveActivePlanV1>): DeferredObjectiveActivePlanV1 => ({
  deviceId: 'dev_a',
  deviceName: 'Device A',
  objectiveKind: 'temperature',
  targetTemperatureC: 21,
  targetPercent: null,
  deadlineAtMs: T0 + 12 * HOUR_MS,
  startedAtMs: T0,
  pending: false,
  objectiveSignature: 'sig',
  original: null,
  latest: {
    revision: 1,
    revisedAtMs: T0,
    computedFromPricesUpTo: T0 + 24 * HOUR_MS,
    reason: 'flow_card',
    hours: [
      { startsAtMs: T0 + 3 * HOUR_MS, plannedKWh: 2 },
      { startsAtMs: T0 + 4 * HOUR_MS, plannedKWh: 2 },
    ],
    energyNeededKWh: 4,
    planStatus: 'on_track',
  },
  ...overrides,
});

const buildActivePlans = (plans: DeferredObjectiveActivePlanV1[]): DeferredObjectiveActivePlansV1 => ({
  version: 1,
  plansByDeviceId: Object.fromEntries(plans.map((plan) => [plan.deviceId, plan])),
});

const buildObjectiveSettings = (
  entries: Record<string, DeferredObjectiveSettingsEntry>,
): DeferredObjectiveSettingsV1 => ({
  version: 1,
  objectivesByDeviceId: entries,
});

const enabledTemperatureEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC: 21,
  deadlineAtMs: T0 + 12 * HOUR_MS,
};

const enabledEvEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'ev_soc',
  enforcement: 'soft',
  targetPercent: 80,
  deadlineAtMs: T0 + 12 * HOUR_MS,
};

const devices: TargetDeviceSnapshot[] = [
  { id: 'dev_a', name: 'Living-room heater', targets: [], currentOn: false, currentTemperature: 18.4 },
  {
    id: 'dev_b',
    name: 'EV charger',
    targets: [],
    currentOn: false,
    stateOfCharge: { percent: 45, status: 'fresh' },
  },
];

describe('resolveDeadlinesListCards', () => {
  it('returns an empty list when no plans exist', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: { version: 1, plansByDeviceId: {} },
      objectiveSettings: buildObjectiveSettings({}),
      devices,
      nowMs: T0,
    });
    expect(cards).toEqual([]);
  });

  it('returns an empty list when activePlans is null', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: null,
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards).toEqual([]);
  });

  it('assigns building_plan status for pending plans with no latest revision', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({ pending: true, latest: null })]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      deviceId: 'dev_a',
      statusId: 'building_plan',
      firstActionAtMs: null,
    });
  });

  it('assigns building_plan status when latest is null regardless of pending flag', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({ latest: null })]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].statusId).toBe('building_plan');
    expect(cards[0].firstActionAtMs).toBeNull();
  });

  it('skips plans whose objective is disabled in settings', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({
        dev_a: { ...enabledTemperatureEntry, enabled: false },
      }),
      devices,
      nowMs: T0,
    });
    expect(cards).toEqual([]);
  });

  it('builds a card with start/end timestamps and device name from devices payload', () => {
    const nowMs = T0; // first hour at T0 + 3h is in the future
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      deviceId: 'dev_a',
      deviceName: 'Living-room heater',
      kind: 'temperature',
      targetTemperatureC: 21,
      createdAtMs: T0,
      firstActionAtMs: T0 + 3 * HOUR_MS,
      deadlineAtMs: T0 + 12 * HOUR_MS,
      href: './?page=deadline-plan&deviceId=dev_a',
      statusId: 'queued', // first hour is in the future relative to nowMs
      confidence: null,
      currentValueLine: 'currently 18.4 °C',
    });
  });

  it('plumbs the per-revision learned-profile confidence band onto the card', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          kwhPerUnitProvenance: {
            source: 'learned',
            kWhPerUnit: 0.55,
            acceptedSamples: 24,
            confidence: 'medium',
            lastAcceptedAtMs: T0,
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].confidence).toBe('medium');
  });

  it('formats currently-X line for EV from device state of charge', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          deviceId: 'dev_b',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 80,
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_b: enabledEvEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].currentValueLine).toBe('currently 45 %');
  });

  it('suppresses the currently-X line when the device has no reading yet', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      // Device exists but has no currentTemperature reading.
      devices: [{ id: 'dev_a', name: 'Living-room heater', targets: [], currentOn: false }],
      nowMs: T0,
    });
    expect(cards[0].currentValueLine).toBeNull();
  });

  it('assigns on_track when first hour has already started', () => {
    const nowMs = T0 + 3 * HOUR_MS + 1; // past first hour start
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs,
    });
    expect(cards[0].statusId).toBe('on_track');
  });

  it('assigns at_risk when planStatus is at_risk', () => {
    const nowMs = T0 + 5 * HOUR_MS; // past all planned hours
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          latest: {
            revision: 1,
            revisedAtMs: T0,
            computedFromPricesUpTo: T0 + 24 * HOUR_MS,
            reason: 'flow_card',
            hours: [{ startsAtMs: T0 + HOUR_MS, plannedKWh: 1 }],
            energyNeededKWh: 2,
            planStatus: 'at_risk',
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs,
    });
    expect(cards[0].statusId).toBe('at_risk');
  });

  it('assigns cannot_meet when planStatus is cannot_meet', () => {
    const nowMs = T0 + 5 * HOUR_MS;
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          latest: {
            revision: 1,
            revisedAtMs: T0,
            computedFromPricesUpTo: T0 + 24 * HOUR_MS,
            reason: 'flow_card',
            hours: [],
            energyNeededKWh: 4,
            planStatus: 'cannot_meet',
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs,
    });
    expect(cards[0].statusId).toBe('cannot_meet');
  });

  it('assigns satisfied when planStatus is satisfied', () => {
    const nowMs = T0 + 5 * HOUR_MS;
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          latest: {
            revision: 1,
            revisedAtMs: T0,
            computedFromPricesUpTo: T0 + 24 * HOUR_MS,
            reason: 'flow_card',
            hours: [],
            energyNeededKWh: 0,
            planStatus: 'satisfied',
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs,
    });
    expect(cards[0].statusId).toBe('satisfied');
  });

  it('assigns paused_unplugged for EV with invalid_session pending reason', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 80,
          pending: true,
          pendingReason: 'invalid_session',
          latest: null,
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledEvEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].statusId).toBe('paused_unplugged');
  });

  it('assigns paused_unplugged when the EV unplugs mid-plan (diagnosticReasonCode on a non-pending plan)', () => {
    // Mid-plan unplug: the recorder keeps `pending: false` and the cached
    // `latest` revision but refreshes `diagnosticReasonCode` to
    // `objective_invalid_session`. The list chip must reflect that — without
    // this branch the chip would say "On track" while the device-card line
    // says "Charging plan paused — car unplugged".
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 80,
          pending: false,
          diagnosticReasonCode: 'objective_invalid_session',
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledEvEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].statusId).toBe('paused_unplugged');
  });

  it('resolves the device name by the map key, not by plan.deviceId, so a corrupted record cannot mis-name the card', () => {
    // Persisted plan has `deviceId: 'dev_other'` inside the value, but is stored
    // under key `dev_a`. The card must be named after `dev_a` (the key drives
    // the href + enabled lookup) — using plan.deviceId would link to dev_a
    // while naming it 'Other device', which would mislead the user.
    const plansByDeviceId = {
      dev_a: { ...buildPlan({}), deviceId: 'dev_other', deviceName: 'Stored fallback' },
    };
    const cards = resolveDeadlinesListCards({
      activePlans: { version: 1, plansByDeviceId },
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices: [
        { id: 'dev_a', name: 'Living-room heater', targets: [], currentOn: false },
        { id: 'dev_other', name: 'Other device', targets: [], currentOn: false },
      ],
      nowMs: T0,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].deviceId).toBe('dev_a');
    expect(cards[0].deviceName).toBe('Living-room heater');
    expect(cards[0].href).toBe('./?page=deadline-plan&deviceId=dev_a');
  });

  it('falls back to plan.deviceName when the device is missing from the devices payload', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({ deviceId: 'dev_x', deviceName: 'Fallback' })]),
      objectiveSettings: buildObjectiveSettings({ dev_x: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].deviceName).toBe('Fallback');
  });

  it('sets firstActionAtMs to null when latest has no hours', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          latest: {
            revision: 1,
            revisedAtMs: T0,
            computedFromPricesUpTo: T0 + 24 * HOUR_MS,
            reason: 'flow_card',
            hours: [],
            energyNeededKWh: 0,
            planStatus: 'on_track',
          },
        }),
      ]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
      nowMs: T0,
    });
    expect(cards[0].firstActionAtMs).toBeNull();
  });

  it('sorts cards by deadline ascending', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([
        buildPlan({
          deviceId: 'dev_b',
          deviceName: 'EV charger',
          objectiveKind: 'ev_soc',
          targetTemperatureC: null,
          targetPercent: 80,
          deadlineAtMs: T0 + 6 * HOUR_MS,
        }),
        buildPlan({ deviceId: 'dev_a', deadlineAtMs: T0 + 20 * HOUR_MS }),
      ]),
      objectiveSettings: buildObjectiveSettings({
        dev_a: enabledTemperatureEntry,
        dev_b: enabledEvEntry,
      }),
      devices,
      nowMs: T0,
    });
    expect(cards.map((card) => card.deviceId)).toEqual(['dev_b', 'dev_a']);
  });
});

describe('resolveDeadlinesHistoryEntries', () => {
  const buildEntry = (deviceId: string, finalizedAtMs: number) => ({
    deviceId,
    deviceName: deviceId,
    objectiveKind: 'temperature' as const,
    targetTemperatureC: 21,
    targetPercent: null,
    deadlineAtMs: finalizedAtMs,
    startedAtMs: finalizedAtMs - HOUR_MS,
    finalizedAtMs,
    startProgressC: 18,
    startProgressPercent: null,
    finalProgressC: 21,
    finalProgressPercent: null,
    initialEnergyNeededKWh: 2,
    outcome: 'met' as const,
    metAtMs: finalizedAtMs,
    usedDeadlineReserve: false,
    usedPolicyAvoid: false,
    observedIntervals: [],
    discoveredFrom: 'observation' as const,
    id: `entry-${deviceId}-${finalizedAtMs}`,
    originalPlan: null,
    finalPlan: null,
  });

  it('returns an empty list when payload is null', () => {
    expect(resolveDeadlinesHistoryEntries(null)).toEqual([]);
  });

  it('flattens entries across devices, newest finalizedAtMs first', () => {
    const result = resolveDeadlinesHistoryEntries({
      version: 1,
      entriesByDeviceId: {
        dev_a: [buildEntry('dev_a', T0 + 1 * HOUR_MS), buildEntry('dev_a', T0 + 4 * HOUR_MS)],
        dev_b: [buildEntry('dev_b', T0 + 2 * HOUR_MS), buildEntry('dev_b', T0 + 3 * HOUR_MS)],
      },
    });
    expect(result.map((entry) => entry.finalizedAtMs)).toEqual([
      T0 + 4 * HOUR_MS,
      T0 + 3 * HOUR_MS,
      T0 + 2 * HOUR_MS,
      T0 + 1 * HOUR_MS,
    ]);
  });
});

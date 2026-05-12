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

const { resolveDeadlinesListCards } = testExports;

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
  { id: 'dev_a', name: 'Living-room heater', targets: [], currentOn: false },
  { id: 'dev_b', name: 'EV charger', targets: [], currentOn: false },
];

describe('resolveDeadlinesListCards', () => {
  it('returns an empty list when no plans exist', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: { version: 1, plansByDeviceId: {} },
      objectiveSettings: buildObjectiveSettings({}),
      devices,
    });
    expect(cards).toEqual([]);
  });

  it('returns an empty list when activePlans is null', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: null,
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
    });
    expect(cards).toEqual([]);
  });

  it('includes pending plans with pending=true and firstActionAtMs=null', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({ pending: true, latest: null })]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      deviceId: 'dev_a',
      pending: true,
      firstActionAtMs: null,
    });
  });

  it('includes plans with no latest revision as pending', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({ latest: null })]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].pending).toBe(true);
    expect(cards[0].firstActionAtMs).toBeNull();
  });

  it('skips plans whose objective is disabled in settings', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({
        dev_a: { ...enabledTemperatureEntry, enabled: false },
      }),
      devices,
    });
    expect(cards).toEqual([]);
  });

  it('builds a card with start/end timestamps and device name from devices payload', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({})]),
      objectiveSettings: buildObjectiveSettings({ dev_a: enabledTemperatureEntry }),
      devices,
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
      href: './deadline-plan.html?deviceId=dev_a&ui=redesign',
      pending: false,
    });
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
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].deviceId).toBe('dev_a');
    expect(cards[0].deviceName).toBe('Living-room heater');
    expect(cards[0].href).toBe('./deadline-plan.html?deviceId=dev_a&ui=redesign');
  });

  it('falls back to plan.deviceName when the device is missing from the devices payload', () => {
    const cards = resolveDeadlinesListCards({
      activePlans: buildActivePlans([buildPlan({ deviceId: 'dev_x', deviceName: 'Fallback' })]),
      objectiveSettings: buildObjectiveSettings({ dev_x: enabledTemperatureEntry }),
      devices,
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
    });
    expect(cards.map((card) => card.deviceId)).toEqual(['dev_b', 'dev_a']);
  });
});

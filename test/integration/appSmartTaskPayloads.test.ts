import { describe, expect, it } from 'vitest';

import type {
  DeferredObjectiveActivePlansV1,
  DeferredObjectiveActivePlanV1,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryRecord,
  DeferredObjectivePlanHistoryV5,
} from '../../packages/contracts/src/deferredObjectivePlanHistory';
import type {
  DeferredObjectiveActivePlanRecorder,
  DeferredObjectivePlanHistoryRecorder,
} from '../../lib/objectives/deferredObjectives';
import {
  AppSmartTaskPayloads,
  type SmartTaskPayloadsContext,
} from '../../setup/appSmartTaskPayloads';
import { EnergyTaskDeliveryTracker, type EnergyDeliveryRun } from '../../lib/objectives/deferredObjectives/energyDelivery';
import { createMemoryEnergyDeliveryStore, everyReadingLive } from '../helpers/deferredObjectiveWiringFixtures';

// Read-only payload assembly over the two deferred-objective recorders. Only
// the recorders (the layer's outward seam) are stubbed; the trajectory stitcher
// and the resolved-view producers run for real, so these assert the payloads the
// settings UI and the smart-tasks widget actually receive.
//
// The happy paths reachable from the app class (resolved view, per-device
// newest-first ordering) are asserted end to end in
// `appSmartTaskDelegation.test.ts`; this spec owns the edge cases that need a
// hand-built recorder — trajectory stitching, a degraded boot with no history
// recorder, the no-mutation guard, and a junk `finalizedAtMs`.

const buildActivePlan = (
  overrides: Partial<DeferredObjectiveActivePlanV1> = {},
): DeferredObjectiveActivePlanV1 => ({
  deviceId: 'dev-1',
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetValue: 65,
  deadlineAtMs: 5_000,
  startedAtMs: 1_000,
  pending: false,
  objectiveSignature: 'sig-1',
  original: null,
  latest: null,
  ...overrides,
});

const buildHistoryEntry = (
  overrides: Partial<DeferredObjectivePlanHistoryRecord> = {},
): DeferredObjectivePlanHistoryRecord => ({
  id: 'entry-1',
  deviceId: 'dev-1',
  targetValue: 65,
  deadlineAtMs: 5_000,
  startedAtMs: 1_000,
  finalizedAtMs: 4_000,
  startProgressValue: 40,
  finalProgressValue: 65,
  initialEnergyNeededKWh: 2,
  outcome: 'met',
  metAtMs: 3_900,
  usedDeadlineReserve: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  ...overrides,
});

type Recorders = {
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  history?: DeferredObjectivePlanHistoryV5;
  trajectoryByDeviceId?: Record<string, ReturnType<DeferredObjectivePlanHistoryRecorder['getInProgressTrajectory']>>;
  wireHistoryRecorder?: boolean;
  energyRuns?: readonly EnergyDeliveryRun[];
};

type HistoryDevice = {
  id: string;
  name: string;
  deviceClass?: string;
  deviceType?: 'temperature' | 'onoff';
  isEvCharger?: boolean;
  binaryControllable?: boolean;
  targets: [];
  temperature?: {
    currentTemperature: number;
    target: { id: 'target_temperature'; value: number };
  };
};

const TEMPERATURE = {
  currentTemperature: 50,
  target: { id: 'target_temperature' as const, value: 65 },
};
const DEFAULT_HISTORY_DEVICES: readonly HistoryDevice[] = [
  {
    id: 'dev-1', name: 'Connected 300', deviceClass: 'thermostat', deviceType: 'temperature', targets: [],
    temperature: TEMPERATURE,
  },
  {
    id: 'dev-2', name: 'Connected 300', deviceClass: 'thermostat', deviceType: 'temperature', targets: [],
    temperature: TEMPERATURE,
  },
];

const buildPayloads = (
  options: Recorders = {},
  devices: ReadonlyArray<HistoryDevice> = DEFAULT_HISTORY_DEVICES,
): AppSmartTaskPayloads => {
  const activePlanRecorder = {
    getActivePlansSnapshot: () => options.activePlans ?? null,
  } as unknown as DeferredObjectiveActivePlanRecorder;
  const historyRecorder = {
    getHistorySnapshot: () => options.history,
    getInProgressTrajectory: (deviceId: string) => options.trajectoryByDeviceId?.[deviceId] ?? null,
  } as unknown as DeferredObjectivePlanHistoryRecorder;
  const ctx: SmartTaskPayloadsContext = {
    deferredObjectiveActivePlanRecorder: activePlanRecorder,
    deferredObjectivePlanHistoryRecorder: options.wireHistoryRecorder === false ? undefined : historyRecorder,
    deferredObjectiveEnergyDelivery: new EnergyTaskDeliveryTracker(
      createMemoryEnergyDeliveryStore(options.energyRuns),
      everyReadingLive,
    ),
    getDeviceSurfaces: () => devices as never,
  };
  return new AppSmartTaskPayloads(ctx);
};

describe('AppSmartTaskPayloads.getDeferredObjectiveActivePlansUiPayload', () => {
  it('stitches the live in-progress trajectory onto a running plan', () => {
    const payload = buildPayloads({
      activePlans: { version: 1, plansByDeviceId: { 'dev-1': buildActivePlan() } },
      trajectoryByDeviceId: {
        'dev-1': { startProgressValue: 42, progressSamples: [{ atMs: 2_000, value: 50 }] },
      },
    }).getDeferredObjectiveActivePlansUiPayload();
    const plan = payload?.plansByDeviceId['dev-1'];
    expect(plan?.startProgressValue).toBe(42);
    expect(plan?.progressSamples).toEqual([{ atMs: 2_000, value: 50 }]);
  });

  it('still resolves the snapshot when no history recorder is wired (degraded boot)', () => {
    const payload = buildPayloads({
      activePlans: { version: 1, plansByDeviceId: { 'dev-1': buildActivePlan() } },
      wireHistoryRecorder: false,
    }).getDeferredObjectiveActivePlansUiPayload();
    expect(payload?.plansByDeviceId['dev-1']?.targetValue).toBe(65);
    expect(payload?.plansByDeviceId['dev-1']).not.toHaveProperty('progressSamples');
  });

  it('passes a null plan through untouched (degraded-state defense, no crash)', () => {
    const payload = buildPayloads({
      // The record type is non-null, but degraded runtime states can yield null.
      activePlans: { version: 1, plansByDeviceId: { 'dev-1': null as unknown as DeferredObjectiveActivePlanV1 } },
    }).getDeferredObjectiveActivePlansUiPayload();
    expect(payload?.plansByDeviceId['dev-1']).toBeNull();
  });

  it('does not mutate the recorder snapshot it was handed', () => {
    const plan = buildActivePlan();
    const snapshot: DeferredObjectiveActivePlansV1 = { version: 1, plansByDeviceId: { 'dev-1': plan } };
    buildPayloads({
      activePlans: snapshot,
      trajectoryByDeviceId: {
        'dev-1': { startProgressValue: 42, progressSamples: [] },
      },
    }).getDeferredObjectiveActivePlansUiPayload();
    expect(snapshot.plansByDeviceId['dev-1']).toBe(plan);
    expect(plan).not.toHaveProperty('startProgressValue');
  });
});

describe('AppSmartTaskPayloads.getDeferredObjectivePlanHistoryUiPayload', () => {
  it('returns the empty payload when the recorder has no snapshot', () => {
    expect(buildPayloads().getDeferredObjectivePlanHistoryUiPayload())
      .toEqual({ version: 1, entriesByDeviceId: {} });
  });

  it('partitions entries per device', () => {
    const payload = buildPayloads({
      history: {
        version: 5,
        entries: [
          buildHistoryEntry({ id: 'mine' }),
          buildHistoryEntry({ id: 'other-device', deviceId: 'dev-2', finalizedAtMs: 2_000 }),
        ],
      },
    }).getDeferredObjectivePlanHistoryUiPayload();
    expect(payload.entriesByDeviceId['dev-1']?.map((entry) => entry.id)).toEqual(['mine']);
    expect(payload.entriesByDeviceId['dev-2']?.map((entry) => entry.id)).toEqual(['other-device']);
  });

  it('resolves each entry to the unit-agnostic view', () => {
    const payload = buildPayloads({
      history: { version: 5, entries: [buildHistoryEntry()] },
    }).getDeferredObjectivePlanHistoryUiPayload();
    const entry = payload.entriesByDeviceId['dev-1']?.[0];
    expect(entry?.targetValue).toBe(65);
    expect(entry?.startProgressValue).toBe(40);
    expect(entry).not.toHaveProperty('targetTemperatureC');
  });

  it('uses the current device name and inferred objective kind', () => {
    const payload = buildPayloads({
      history: { version: 5, entries: [buildHistoryEntry()] },
    }, [{ id: 'dev-1', name: 'Renamed charger', deviceClass: 'evcharger', isEvCharger: true, targets: [] }])
      .getDeferredObjectivePlanHistoryUiPayload();
    expect(payload.entriesByDeviceId['dev-1']?.[0]).toMatchObject({
      deviceName: 'Renamed charger',
      objectiveKind: 'ev_soc',
    });
  });

  it('hides retained history while its device cannot be resolved', () => {
    const payload = buildPayloads({
      history: { version: 5, entries: [buildHistoryEntry()] },
    }, []).getDeferredObjectivePlanHistoryUiPayload();
    expect(payload.entriesByDeviceId).toEqual({});
  });
});

describe('AppSmartTaskPayloads.getDeferredObjectivePlanHistoryRecentUiPayload', () => {
  it('keeps only entries finalized at or after the cutoff', () => {
    const payload = buildPayloads({
      history: {
        version: 5,
        entries: [
          buildHistoryEntry({ id: 'stale', finalizedAtMs: 1_000 }),
          buildHistoryEntry({ id: 'boundary', finalizedAtMs: 5_000 }),
          buildHistoryEntry({ id: 'recent', finalizedAtMs: 7_000 }),
        ],
      },
    }).getDeferredObjectivePlanHistoryRecentUiPayload(5_000);
    expect(payload.entriesByDeviceId['dev-1']?.map((entry) => entry.id)).toEqual(['recent', 'boundary']);
  });

  it('drops an entry with a non-finite finalizedAtMs rather than ordering it arbitrarily', () => {
    const payload = buildPayloads({
      history: {
        version: 5,
        entries: [buildHistoryEntry({ id: 'junk', finalizedAtMs: Number.NaN })],
      },
    }).getDeferredObjectivePlanHistoryRecentUiPayload(0);
    expect(payload.entriesByDeviceId).toEqual({});
  });
});

describe('AppSmartTaskPayloads energy tasks', () => {
  const energyPlan = buildActivePlan({
    deviceId: 'relay-1',
    deviceName: 'Water heater relay',
    objectiveKind: 'energy',
    targetValue: 16,
  });

  it('reads an energy plan\'s progress from the energy fed so far, every other plan\'s from the device', () => {
    const payload = buildPayloads({
      activePlans: { version: 1, plansByDeviceId: { 'relay-1': energyPlan, 'dev-1': buildActivePlan() } },
      energyRuns: [{ deviceId: 'relay-1', deadlineAtMs: 5_000, startedAtMs: 1_000, deliveredKWh: 6.5 }],
    }).getDeferredObjectiveActivePlansUiPayload();
    expect(payload?.plansByDeviceId['relay-1']).toMatchObject({ targetValue: 16, deliveredKWh: 6.5 });
    expect(payload?.plansByDeviceId['dev-1']).not.toHaveProperty('deliveredKWh');
  });

  it('reads an energy run in history as an energy run, off the on/off device it ran on', () => {
    const payload = buildPayloads({
      history: {
        version: 5,
        entries: [buildHistoryEntry({ id: 'energy-run', deviceId: 'relay-1', targetValue: 6 })],
      },
    }, [{ id: 'relay-1', name: 'Water heater relay', deviceType: 'onoff', binaryControllable: true, targets: [] }])
      .getDeferredObjectivePlanHistoryUiPayload();
    expect(payload.entriesByDeviceId['relay-1']?.map((entry) => [entry.id, entry.objectiveKind])).toEqual([
      ['energy-run', 'energy'],
    ]);
  });
});

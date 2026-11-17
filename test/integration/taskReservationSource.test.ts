import { describe, expect, it, vi } from 'vitest';
import type {
  DeferredObjectiveActivePlansV2, DeferredObjectiveActivePlanV1, DeferredObjectiveActivePlanRevisionV1,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveRoster, DeferredObjectiveSettingsEntry } from '../../packages/contracts/src/deferredObjectiveSettings';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';
import { ObjectiveTaskReservationSource } from '../../lib/objectives/deferredObjectives/taskReservationSource';
import { buildObjectiveSignatureForEntry } from '../../lib/objectives/deferredObjectives/activePlanSignature';
import { reservationEnergy, reservationPowerKW } from '../../lib/battery/batteryTaskReservations';
import { createContinuousBatteryPlanSource } from '../../lib/battery/continuousBatteryHorizon';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { BatteryControlOwner } from '../../lib/ports/batteryControlOwner';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { withDeviceConfiguration } from '../utils/planTestUtils';
import { decoratedSnapshotFixture } from '../utils/deviceSnapshotFixture';
import { toPlanDevice } from '../../setup/appInit/toPlanDevice';
import { partialDouble } from '../helpers/partialDouble';
import { TaskAllocationRoster } from '../../lib/objectives/deferredObjectives/taskAllocationRoster';
import { planningTurnContext } from '../../lib/objectives/deferredObjectives/taskPlanningTurns';
import { orderDeferredObjectives } from '../../lib/objectives/deferredObjectives/priorityAllocation';
import { createFixturePriorityQuery } from '../helpers/modePriorityFixtures';
import { noDeviceExclusion } from '../helpers/deferredObjectiveWiringFixtures';

const HOUR_MS = 3_600_000;
const NOW = Date.parse('2026-11-07T11:00:00Z');
const START = NOW + HOUR_MS;
const END = START + HOUR_MS;
const objective: DeferredObjectiveSettingsEntry = {
  enabled: true, kind: 'energy', targetEnergyKWh: 0.56, enforcement: 'soft', deadlineAtMs: END,
};
const device: ObjectiveDeviceInput = {
  id: 'heater', name: 'Heater', deviceType: 'onoff', isEvCharger: false,
  currentDrawKw: 0, expectedPowerKw: 3, control: { managed: true, commandAuthority: true },
  objectiveSessionInactive: false, waitingForCarAssociation: false, thermalDirection: 'heating',
  steppedLoadProfile: { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'on', planningPowerW: 3000 }] },
};
const limits = { limitKw: 5, marginKw: 0, periodMinutes: 60 as const, capacityEnabled: true, gridImportLimitKw: null };
const booking = { startsAtMs: START, endsAtMs: END, plannedKWh: 0.56, plannedAdmissionPowerKw: 3 };
const plan = (latest: Partial<DeferredObjectiveActivePlanRevisionV1> = {}): DeferredObjectiveActivePlanV1 => (
  partialDouble<DeferredObjectiveActivePlanV1>({
    deviceId: device.id, objectiveKind: objective.kind, deadlineAtMs: END, pending: false,
    objectiveSignature: buildObjectiveSignatureForEntry(objective, 'increasing'),
    commitment: { committedAtMs: NOW, hours: [booking] }, liveCompletion: { kind: 'unmet', status: 'on_track' },
    latest: partialDouble<DeferredObjectiveActivePlanRevisionV1>({
      revision: 1, revisedAtMs: NOW,
      allocationContextSignature: planningTurnContext([{
        deviceId: device.id, objective, device, priority: 1, reservationEligible: true, higherRankedDeviceIds: [],
      }], { version: 2, plansByDeviceId: {} }),
      hours: [booking], reservationSegments: [{ startMs: START, endMs: END, plannedKWh: 0.56, plannedAdmissionPowerKw: 3 }],
      ...latest,
    }),
  })
);
const roster = (entry = objective): DeferredObjectiveRoster => ({ objectivesByDeviceId: { heater: entry } });
const active = (task = plan()): DeferredObjectiveActivePlansV2 => ({ version: 2, plansByDeviceId: { heater: task } });
const reservationReaders = (tasks: DeferredObjectiveActivePlansV2, devices: ObjectiveDeviceInput[] = [device]) => ({
  getChargingPhaseEnvelopes: () => new Map(), getDeferredObjectiveActivePlans: () => tasks,
  getCapacitySettings: () => limits, getThermalDirection: () => 'heating' as const,
  allocationRoster: new TaskAllocationRoster(() => new Date(NOW)), resolveDeviceExclusion: noDeviceExclusion,
  getPrioritiesForDevices: createFixturePriorityQuery(devices.map(({ id }, index) => ({ id, priority: index + 1 }))),
});
const source = (
  tasks = active(),
  settings: DeferredObjectiveRoster | undefined = roster(),
  devices: ObjectiveDeviceInput[] = [device],
) => new ObjectiveTaskReservationSource(reservationReaders(tasks, devices), () => settings, () => devices, (input) => input);
const ids = new Set(['heater']);

const withPlanningContexts = (
  tasks: DeferredObjectiveActivePlansV2, settings: DeferredObjectiveRoster, devices: ObjectiveDeviceInput[],
): DeferredObjectiveActivePlansV2 => {
  const readers = reservationReaders(tasks, devices);
  const ordered = orderDeferredObjectives(settings, new Map(devices.map((entry) => [entry.id, entry])),
    () => false, readers.allocationRoster.read(NOW), tasks, readers.getPrioritiesForDevices);
  return { ...tasks, plansByDeviceId: Object.fromEntries(ordered.map((entry, index) => {
    const record = tasks.plansByDeviceId[entry.deviceId];
    if (!record?.latest) throw new Error('Expected a committed fixture');
    return [entry.deviceId, { ...record, latest: {
      ...record.latest, allocationContextSignature: planningTurnContext(ordered.slice(0, index + 1), tasks),
    } }];
  })) };
};

describe('objective-owned battery task reservations', () => {
  it('projects task devices without re-entering the battery plan or the home plan builder', () => {
    const readBattery = vi.fn(() => { throw new Error('Battery planning must not recurse'); });
    const ctx = createAppContextMock({ readContinuousBatteryPlan: readBattery });
    const snapshot = (id: string) => withDeviceConfiguration(decoratedSnapshotFixture({
      id, name: id, available: true, expectedPowerKw: 3, expectedPowerSource: 'default', targets: [],
      binaryControl: { on: false }, measuredPowerKw: 0,
    }));
    const input = new ObjectiveTaskReservationSource(reservationReaders(active()),
      () => roster(), () => [snapshot('battery'), snapshot('heater')], entry => toPlanDevice(ctx, entry));
    expect(input.read(NOW, ids).kind).toBe('ready');
    expect(readBattery).not.toHaveBeenCalled();
  });
  it('keeps economic booking energy separate from a future physical draw window', () => {
    const read = source().read(NOW, ids);
    if (read.kind !== 'ready') throw new Error('Expected reservations');
    expect(read.energy).toEqual([{ startMs: START, endMs: END, plannedKWh: 0.56 }]);
    expect(read.admission).toHaveLength(1);
    expect(read.admission[0].endMs).toBeCloseTo(START + 0.56 / 3 * HOUR_MS, 4);
    expect(reservationPowerKW(read.admission, START + HOUR_MS / 2, END)).toBe(0);
    expect(reservationEnergy(read.energy, START, END)).toBeCloseTo(0.56);
  });

  it('slides started admission from now without squeezing its full energy into the remaining period', () => {
    const nowMs = END - HOUR_MS / 6;
    const read = source().read(nowMs, ids);
    if (read.kind !== 'ready') throw new Error('Expected reservations');
    expect(read.admission).toEqual([{ startMs: nowMs, endMs: END, admissionPowerKw: 3 }]);
    expect(reservationEnergy(read.energy, nowMs, END)).toBeCloseTo(0.56 / 6);
  });

  it('uses useful delivery for duration and caps stale admission at the current ladder', () => {
    const calibrated = { ...device, stepPowerCalibration: { on: 1.5 } };
    const task = plan({ reservationSegments: [{ startMs: START, endMs: END, plannedKWh: 0.56, plannedAdmissionPowerKw: 7 }] });
    const read = source(active(task), roster(), [calibrated]).read(NOW, ids);
    if (read.kind !== 'ready') throw new Error('Expected reservations');
    expect(read.admission[0].admissionPowerKw).toBe(3);
    expect(read.admission[0].endMs).toBeCloseTo(START + 0.56 / 1.5 * HOUR_MS, 4);
  });

  it.each([true, false])('resolves legacy admission from a known rung or conservative ceiling (device present: %s)', (present) => {
    const task = plan({ reservationSegments: undefined, hours: [{ ...booking, plannedAdmissionPowerKw: undefined }] });
    const read = source(active(task), roster(), present ? [device] : []).read(NOW, ids);
    if (read.kind !== 'ready') throw new Error('Expected reservations');
    expect(read.admission[0].admissionPowerKw).toBe(present ? 3 : 5);
    expect(read.admission[0].endMs).toBe(present ? START + 0.56 / 3 * HOUR_MS : END);
  });

  it.each(['pending', 'signature', 'commitment', 'kind', 'deadline'] as const)('waits for an incoherent %s commitment', (reason) => {
    const overrides = {
      pending: { pending: true }, signature: { objectiveSignature: 'old' }, commitment: { commitment: undefined },
      kind: { objectiveKind: 'ev_soc' as const }, deadline: { deadlineAtMs: END + HOUR_MS },
    };
    expect(source(active({ ...plan(), ...overrides[reason] })).read(NOW, ids)).toEqual({ kind: 'waiting' });
  });

  it('waits for a new obligation even when an older persisted task was satisfied', () => {
    const stale = { ...plan(), objectiveSignature: 'older obligation', liveCompletion: { kind: 'satisfied' as const } };
    expect(source(active(stale)).read(NOW, ids)).toEqual({ kind: 'waiting' });
  });

  it('waits for a legacy commitment to receive its coordinated planning context', () => {
    expect(source(active(plan({ allocationContextSignature: undefined }))).read(NOW, ids))
      .toEqual({ kind: 'waiting' });
  });

  it('does not spend bookings while the task is explicitly waiting for a plan', () => {
    const queued = { ...plan(), diagnosticReasonCode: 'objective_waiting_for_plan' as const };
    expect(source(active(queued)).read(NOW, ids)).toEqual({ kind: 'waiting' });
  });

  it('detects an incompatible higher revision before the waiting overlay is recorded', () => {
    const lowerDevice = { ...device, id: 'lower', name: 'Lower' };
    const settings = { objectivesByDeviceId: { heater: objective, lower: objective } };
    const coordinated = withPlanningContexts({ version: 2, plansByDeviceId: {
      heater: plan(), lower: { ...plan(), deviceId: lowerDevice.id },
    } }, settings, [device, lowerDevice]);
    const managedIds = new Set(['heater', 'lower']);
    expect(source(coordinated, settings, [device, lowerDevice]).read(NOW, managedIds).kind).toBe('ready');
    const high = coordinated.plansByDeviceId.heater;
    if (!high.latest) throw new Error('Expected higher revision');
    const changed: DeferredObjectiveActivePlansV2 = { ...coordinated, plansByDeviceId: {
      ...coordinated.plansByDeviceId, heater: { ...high, latest: {
        ...high.latest, revision: high.latest.revision + 1, revisedAtMs: NOW + 30_000,
        reservationSegments: [{ startMs: START, endMs: END, plannedKWh: 0.8, plannedAdmissionPowerKw: 3 }],
      } },
    } };
    expect(changed.plansByDeviceId.lower.diagnosticReasonCode).toBeUndefined();

    expect(source(changed, settings, [device, lowerDevice]).read(NOW + 30_000, managedIds))
      .toEqual({ kind: 'waiting' });
  });

  it('includes managed non-task devices when resolving the task priority', () => {
    const ordinary = { ...device, id: 'ordinary', name: 'Ordinary' };
    const coordinated = withPlanningContexts(active(), roster(), [ordinary, device]);

    expect(source(coordinated, roster(), [ordinary, device]).read(NOW, new Set(['ordinary', 'heater'])).kind)
      .toBe('ready');
  });

  it('waits for unavailable settings and excludes paused, cleared, out-of-scope and satisfied tasks', () => {
    const readers = reservationReaders(active());
    expect(new ObjectiveTaskReservationSource(readers, () => undefined, () => [device], input => input).read(NOW, ids))
      .toEqual({ kind: 'waiting' });
    const empty = { kind: 'ready', taskDeviceIds: new Set(), energy: [], admission: [] };
    expect(source(active(), roster({ ...objective, enabled: false })).read(NOW, ids)).toEqual(empty);
    expect(source(active(), { objectivesByDeviceId: {} }).read(NOW, ids)).toEqual(empty);
    expect(source().read(NOW, new Set())).toEqual(empty);
    expect(source(active({ ...plan(), liveCompletion: { kind: 'satisfied' } })).read(NOW, ids)).toEqual(empty);
  });

  it('retains task ownership with zero bookings so standing draw is not counted twice', () => {
    const read = source(active(plan({ hours: [], reservationSegments: [] }))).read(NOW, ids);
    expect(read).toEqual({ kind: 'ready', taskDeviceIds: ids, energy: [], admission: [] });
  });

  it('frees future battery charge room after projected drawing while preserving the booked economic energy', () => {
    const horizon = createContinuousBatteryPlanSource({
      getNowMs: () => NOW,
      getDevices: () => [partialDouble<DeviceSurfaces>({
        id: 'battery', managed: true, available: true, isBatteryOrSolar: true,
        batteryLevel: { percent: 40, observedAtMs: NOW }, batteryPower: { signedW: 0, observedAtMs: NOW },
      }), partialDouble<DeviceSurfaces>({ id: 'heater', managed: true, isBatteryOrSolar: false })],
      getControl: () => partialDouble<BatteryControlOwner>({ readControl: () => ({
        kind: 'setpoint', admissible: true, range: { minW: -5000, maxW: 5000, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
        chargeCeiling: { everyLevelW: 5000, taper: [], planningTaper: [] }, deliveryCeilingW: 5000,
        claimEngaged: false, claimHeld: false, handBackDeferred: false, verdict: 'responding', keepAliveFor: () => ({ kind: 'none' }), pacing: { kind: 'unpaced' }, response: { kind: 'delivers_setpoint' }, gridCharge: { kind: 'any' }, ownModeGridCharge: { kind: 'observed' },
      }) }),
      getControllableDevices: () => ({}), getPowerLimitSettings: () => limits,
      getPrioritiesForDevices: () => ({ getPriority: () => 1 }),
      taskReservations: source(), solarScope: { mainDevices: () => [], allDevices: () => [] },
      getBackgroundKWh: () => 0.5, getSolarForecast: () => ({ forecast: () => [] }),
      getPriceTimeline: () => ({
        state: 'ready', priceUnit: 'EUR/kWh', hasExportPrice: false,
        lines: { average: 0.2, cheapAtOrBelow: 0.1, expensiveFrom: 0.3 },
        periods: [NOW, START].map(start => ({ startsAt: new Date(start).toISOString(), durationMinutes: 60, importPrice: 0.2, level: 'normal' })),
      }),
    }).readHorizons(NOW, [{ deviceId: 'battery', config: {
      enabled: true, usableCapacityKWh: 10, minimumReservePercent: 20, roundTripEfficiency: 0.9,
      wearCostPerKWh: 0.03, priceUnit: 'EUR/kWh', exportPolicy: { kind: 'household_only' },
    } }]).get('battery');
    if (horizon?.kind !== 'ready') throw new Error('Expected horizon');
    const future = horizon.horizon.periods.filter(period => period.startsAtMs >= START);
    expect(future.map(period => period.maxChargeKW)).toEqual([1.5, 4.5]);
    expect(future.reduce((total, period) => total + period.otherManagedDemandKWh, 0)).toBeCloseTo(0.56);
  });
});

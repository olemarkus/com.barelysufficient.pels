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
      hours: [booking], reservationSegments: [{ startMs: START, endMs: END, plannedKWh: 0.56, plannedAdmissionPowerKw: 3 }],
      ...latest,
    }),
  })
);
const roster = (entry = objective): DeferredObjectiveRoster => ({ objectivesByDeviceId: { heater: entry } });
const active = (task = plan()): DeferredObjectiveActivePlansV2 => ({ version: 2, plansByDeviceId: { heater: task } });
const source = (
  tasks = active(),
  settings: DeferredObjectiveRoster | undefined = roster(),
  devices: ObjectiveDeviceInput[] = [device],
) => new ObjectiveTaskReservationSource({
  getDeferredObjectiveActivePlans: () => tasks, getCapacitySettings: () => limits, getThermalDirection: () => 'heating',
}, () => settings, () => devices, (input) => input);
const ids = new Set(['heater']);

describe('objective-owned battery task reservations', () => {
  it('projects task devices without re-entering the battery plan or the home plan builder', () => {
    const readBattery = vi.fn(() => { throw new Error('Battery planning must not recurse'); });
    const ctx = createAppContextMock({ readContinuousBatteryPlan: readBattery });
    const snapshot = (id: string) => withDeviceConfiguration(decoratedSnapshotFixture({
      id, name: id, available: true, expectedPowerKw: 3, expectedPowerSource: 'default', targets: [],
      binaryControl: { on: false }, measuredPowerKw: 0,
    }));
    const input = new ObjectiveTaskReservationSource({
      getDeferredObjectiveActivePlans: () => active(), getCapacitySettings: () => limits, getThermalDirection: () => 'heating',
    }, () => roster(), () => [snapshot('battery'), snapshot('heater')], entry => toPlanDevice(ctx, entry));
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

  it('waits for unavailable settings and excludes paused, cleared, out-of-scope and satisfied tasks', () => {
    const readers = { getDeferredObjectiveActivePlans: () => active(), getCapacitySettings: () => limits, getThermalDirection: () => 'heating' as const };
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
        claimEngaged: false, claimHeld: false, handBackDeferred: false, verdict: 'responding', keepAliveFor: () => ({ kind: 'none' }),
      }) }),
      getControllableDevices: () => ({}), getPowerLimitSettings: () => limits,
      taskReservations: source(), solarScope: { mainDevices: () => [], allDevices: () => [] },
      getBackgroundKWh: () => 0.5, getSolarForecast: () => ({ forecast: () => [] }),
      getPriceTimeline: () => ({
        state: 'ready', priceUnit: 'EUR/kWh', hasExportPrice: false,
        lines: { average: 0.2, cheapAtOrBelow: 0.1, expensiveFrom: 0.3 },
        periods: [NOW, START].map(start => ({ startsAt: new Date(start).toISOString(), durationMinutes: 60, importPrice: 0.2, level: 'normal' })),
      }),
    }).readHorizon('battery', {
      enabled: true, usableCapacityKWh: 10, minimumReservePercent: 20, roundTripEfficiency: 0.9,
      wearCostPerKWh: 0.03, priceUnit: 'EUR/kWh', exportPolicy: { kind: 'household_only' },
    });
    if (horizon.kind !== 'ready') throw new Error('Expected horizon');
    const future = horizon.horizon.periods.filter(period => period.startsAtMs >= START);
    expect(future.map(period => period.maxChargeKW)).toEqual([1.5, 4.5]);
    expect(future.reduce((total, period) => total + period.otherManagedDemandKWh, 0)).toBeCloseTo(0.56);
  });
});

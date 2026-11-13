import type {
  DeferredObjectiveRoster, DeferredObjectiveSettingsEntry,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { DeferredObjectiveActivePlansV2 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { PowerLimitSettings } from '../../../packages/contracts/src/capacitySettings';
import type {
  TaskAdmissionReservation, TaskEnergyReservation, TaskReservationSource, TaskReservationsRead,
} from '../../ports/taskReservations';
import {
  resolveObjectiveDeviceInputs, resolveObjectiveProgressDirectionRead, withPermittedChargingEnvelopes,
  type ObjectiveDeviceSource, type ObjectiveDeviceInput,
} from '../types';
import type { DeferredObjectivePriorityReservation } from './policyHorizon';
import { committedPriorityReservations, narrowPriorityReservations } from './priorityAllocation';
import { resolveActiveCommittedPlan } from './resolveCommittedHours';
import type { TaskEvaluationSource } from './taskEvaluationCoordinator';

type ReservationReaders = Pick<TaskEvaluationSource,
  'getDeferredObjectiveActivePlans' | 'getCapacitySettings' | 'getThermalDirection' | 'getChargingPhaseEnvelopes'>;

/** Original economic coverage is independent of the projected admission window. */
const energyReservations = (
  reservations: readonly DeferredObjectivePriorityReservation[],
  nowMs: number,
): TaskEnergyReservation[] => reservations.flatMap((reservation) => (
  reservation.energySegments.filter((segment) => segment.plannedKWh > 0 && segment.endMs > nowMs)
));

const admissionReservations = (
  reservations: readonly DeferredObjectivePriorityReservation[],
  nowMs: number,
): TaskAdmissionReservation[] => reservations.flatMap((reservation) => (
  reservation.energySegments
    .filter((segment) => segment.plannedKWh > 0 && segment.endMs > nowMs)
    .map((segment) => ({
      startMs: segment.startMs, endMs: segment.endMs, admissionPowerKw: reservation.admissionPowerKw,
    }))
));

/** Resolve one configured obligation completely before including it in the household read. */
function readTaskReservations(
  deviceId: string,
  objective: DeferredObjectiveSettingsEntry,
  device: ObjectiveDeviceInput | undefined,
  activePlans: DeferredObjectiveActivePlansV2,
  powerLimits: PowerLimitSettings,
  nowMs: number,
): TaskReservationsRead {
  const plan = activePlans.plansByDeviceId[deviceId];
  if (plan === undefined) return { kind: 'waiting' };
  const committed = resolveActiveCommittedPlan(deviceId, objective, resolveObjectiveProgressDirectionRead({
    objectiveKind: objective.kind, thermalDirection: device?.thermalDirection ?? 'unknown',
  }), activePlans);
  if (committed === undefined) return { kind: 'waiting' };
  // Only the matching obligation's completion can suppress reservations.
  if (plan.liveCompletion.kind === 'satisfied') {
    return { kind: 'ready', taskDeviceIds: new Set(), energy: [], admission: [] };
  }
  const reservations = committedPriorityReservations(
    deviceId, committed.latest, device, powerLimits, objective.deadlineAtMs, false,
  );
  return {
    kind: 'ready', taskDeviceIds: new Set([deviceId]),
    energy: energyReservations(reservations, nowMs),
    admission: admissionReservations(narrowPriorityReservations(reservations, device, nowMs), nowMs),
  };
}

/**
 * Smart-task persistence is interpreted here, once for economic energy and once
 * for physical admission. Snapshot projection must use the existing no-storage
 * settings projection: reading PlanService.getPlanDevices here would recurse
 * into battery planning. The caller supplies settled managed Main membership;
 * this owner applies task enablement and the metered objective-device gate.
 */
export class ObjectiveTaskReservationSource<Device extends { id: string }> implements TaskReservationSource {
  constructor(
    private readonly readers: ReservationReaders,
    private readonly readRoster: () => DeferredObjectiveRoster | undefined,
    private readonly getDevices: () => readonly Device[],
    private readonly projectDevice: (device: Device) => ObjectiveDeviceSource,
  ) {}

  read(nowMs: number, managedMainDeviceIds: ReadonlySet<string>): TaskReservationsRead {
    const roster = this.readRoster();
    if (roster === undefined) return { kind: 'waiting' };
    const tasks = Object.entries(roster.objectivesByDeviceId).filter(([deviceId, objective]) => (
      managedMainDeviceIds.has(deviceId) && objective.enabled && objective.deadlineAtMs > nowMs
    ));
    const taskIds = new Set(tasks.map(([deviceId]) => deviceId));
    if (taskIds.size === 0) return { kind: 'ready', taskDeviceIds: taskIds, energy: [], admission: [] };
    const devices = resolveObjectiveDeviceInputs(
      withPermittedChargingEnvelopes(
        this.getDevices().filter((device) => taskIds.has(device.id)).map(this.projectDevice),
        this.readers.getChargingPhaseEnvelopes(nowMs),
      ),
      this.readers.getThermalDirection,
    );
    const devicesById = new Map(devices.map((device) => [device.id, device]));
    const activePlans = this.readers.getDeferredObjectiveActivePlans();
    const powerLimits = this.readers.getCapacitySettings();
    const ready = tasks.map(([deviceId, objective]) => readTaskReservations(
      deviceId, objective, devicesById.get(deviceId), activePlans, powerLimits, nowMs,
    )).filter((task) => task.kind === 'ready');
    if (ready.length !== tasks.length) return { kind: 'waiting' };
    return {
      kind: 'ready',
      taskDeviceIds: new Set(ready.flatMap((task) => Array.from(task.taskDeviceIds))),
      energy: ready.flatMap((task) => task.energy),
      admission: ready.flatMap((task) => task.admission),
    };
  }
}

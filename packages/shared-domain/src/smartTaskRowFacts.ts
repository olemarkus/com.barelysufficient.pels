import type { ResolvedDeferredObjectiveActivePlanV1 } from '../../contracts/src/deferredObjectiveActivePlans';
import type {
  ObservedDeviceState,
  ObservedStateOfChargeProbe,
  TemperatureObservedProbe,
} from '../../contracts/src/types';
import {
  resolveReportedCarChargeLimit,
  resolveSmartTaskListStatus,
  type SmartTaskCarChargeLimit,
  type SmartTaskListStatusId,
} from './deadlineLabels';
import { resolveFirstPlannedHourMs } from './deferredPlanBookedHours';
import { hasObservedStateOfCharge } from './stateOfChargeObservedState';
import { hasObservedTemperature } from './temperatureObservedState';

/**
 * What a smart-task row (the Smart tasks list card and the smart-tasks widget
 * row) shows about one active task, resolved once from the plan and the device.
 */
export type SmartTaskRowFacts = {
  statusId: SmartTaskListStatusId;
  // When the device is first planned to run (`resolveFirstPlannedHourMs`).
  firstActionAtMs: number | null;
  // The car limit every surface reports (`resolveReportedCarChargeLimit`).
  carChargeLimit: SmartTaskCarChargeLimit | null;
  // The task's reading right now, null when the device reports none.
  currentValue: number | null;
};

// The device's current value: its temperature for a temperature task, its state
// of charge for an EV task. Null when the device does not report it; the
// current-value line is then suppressed.
//
// Read off the device rather than the plan because the active-plan recorder
// carries no live device readings; the device snapshot does.
const resolveCurrentValue = (
  // Probe-widened: the device snapshot physically carries the observed
  // temperature / SoC the base type omits; `hasObservedTemperature` /
  // `hasObservedStateOfCharge` narrow it (a present reading is finite by the
  // producer invariant — no re-check). SoC is the RESOLVED probe: what the
  // payload serves is the level, so declaring the transport's bag here would let
  // a `report.percent` read compile and then find `undefined` at runtime.
  device: (ObservedDeviceState & TemperatureObservedProbe & ObservedStateOfChargeProbe) | undefined,
  plan: ResolvedDeferredObjectiveActivePlanV1,
): number | null => {
  // An energy task's current value is the energy fed so far, which the plan
  // carries; the device has no reading this task is measured by.
  if (plan.objectiveKind === 'energy') return plan.deliveredKWh;
  if (!device) return null;
  if (plan.objectiveKind === 'temperature') {
    return hasObservedTemperature(device) ? device.temperature.currentTemperature : null;
  }
  // `level`, never the raw report: a bag with no level means PELS has no reading
  // for this charger, and the percentage it last saw belongs to a car that has gone.
  if (!hasObservedStateOfCharge(device)) return null;
  const { level } = device.stateOfCharge;
  return level.kind === 'known' ? level.percent : null;
};

export const resolveSmartTaskRowFacts = (
  plan: ResolvedDeferredObjectiveActivePlanV1,
  device: (ObservedDeviceState & TemperatureObservedProbe & ObservedStateOfChargeProbe) | undefined,
  nowMs: number,
): SmartTaskRowFacts => ({
  statusId: resolveSmartTaskListStatus(plan, nowMs),
  firstActionAtMs: resolveFirstPlannedHourMs(plan.latest),
  carChargeLimit: resolveReportedCarChargeLimit(plan),
  currentValue: resolveCurrentValue(device, plan),
});

// A cached revision outlives the device leaving the planned set, whether by
// meter reassignment (`unavailable`) or by the owner turning "Managed by PELS"
// off. Those hours govern nothing, so no row may advertise a schedule, an
// estimate or a trajectory underneath a chip that says otherwise.
// `paused_unplugged` is deliberately absent: that plan resumes on its own when
// the car is plugged back in.
export const smartTaskScheduleNoLongerGoverns = (statusId: SmartTaskListStatusId): boolean => (
  statusId === 'unavailable' || statusId === 'paused_unmanaged'
);

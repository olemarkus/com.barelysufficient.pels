import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import type { DailyBudgetDayPayload } from '../../packages/contracts/src/dailyBudgetTypes';
import type { SettingsUiPlanSnapshot, SettingsUiPlanDeviceSnapshot } from '../../packages/contracts/src/settingsUiApi';
import type { SupportReportSection, SupportReportValue } from '../../packages/contracts/src/supportReport';
import type {
  DeviceDescriptor, EvObservedProbe, MeasuredPowerObservedProbe, ObservedDeviceState, StateOfChargeObservedProbe,
  SteppedLoadDescriptorProbe, TemperatureObservedProbe,
} from '../../packages/contracts/src/types';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { hasObservedTemperature } from '../../packages/shared-domain/src/temperatureObservedState';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { hoursWithPlannedEnergy } from '../../packages/shared-domain/src/deferredPlanBookedHours';
import { plannedDurationHours } from '../objectives/deferredObjectives/plannedDuration';
import { isTemperaturePlanDevice } from '../plan/planTemperatureDevice';
import type { DevicePlanDevice } from '../plan/planTypes';
import type { CarLinkCarStatus, CarLinkDiagnostics } from '../ports/carLinkDiagnostics';
import type { SmartTaskCycleRecord } from '../objectives/deferredObjectives/smartTaskCycleRecord';
import type { DeferredObjectiveSettingsEntry } from '../../packages/contracts/src/deferredObjectiveSettings';
import type {
  DeferredObjectiveActivePlanRevisionV1, DeferredObjectiveActivePlanV1,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';

const present = (key: string, value: SupportReportValue | undefined): Record<string, SupportReportValue> => (
  value === undefined ? {} : { [key]: value }
);

/** Semantic snapshot facets read by the report, without transport routing or write metadata. */
export type SupportReportDeviceSnapshot = Pick<DeviceDescriptor,
  'id' | 'name' | 'deviceClass' | 'deviceType' | 'managed' | 'binaryControllable' | 'isEvCharger'
  | 'expectedPowerKw' | 'expectedPowerSource' | 'controlModel' | 'flowBacked' | 'budgetExempt'
  | 'priority' | 'controlAdapter'>
  & Pick<ObservedDeviceState, 'available' | 'lastUpdated' | 'binaryControl' | 'targets'>
  & EvObservedProbe
  & MeasuredPowerObservedProbe & StateOfChargeObservedProbe & SteppedLoadDescriptorProbe & TemperatureObservedProbe;

const reportDeviceMeasurements = (device: SupportReportDeviceSnapshot): Record<string, SupportReportValue> => ({
  ...(hasObservedMeasuredPower(device) ? {
    measuredPowerKw: device.measuredPowerKw,
    ...present('measuredPowerObservedAtMs', device.measuredPowerObservedAtMs),
  } : {}),
  ...(hasObservedTemperature(device) ? {
    temperatureC: device.temperature.currentTemperature,
    targetTemperatureC: device.temperature.target.value,
  } : {}),
  ...(isEvObserved(device) ? { evChargingState: device.evChargingState } : {}),
  ...(hasObservedStateOfCharge(device) && device.stateOfCharge.level.kind === 'known' ? {
    stateOfChargePercent: device.stateOfCharge.level.percent,
    stateOfChargeObservedAtMs: device.stateOfCharge.level.observedAtMs,
  } : {}),
});

export const reportDeviceSnapshot = (device: SupportReportDeviceSnapshot): SupportReportSection => ({
  title: 'Current device observation and configuration',
  values: {
    id: device.id, name: device.name, deviceClass: device.deviceClass, deviceType: device.deviceType,
    managed: device.managed, available: device.available, binaryControllable: device.binaryControllable,
    expectedPowerKw: device.expectedPowerKw, expectedPowerSource: device.expectedPowerSource,
    ...present('controlModel', device.controlModel),
    ...present('flowBacked', device.flowBacked),
    ...present('budgetExempt', device.budgetExempt),
    ...present('priority', device.priority),
    ...present('lastUpdatedMs', device.lastUpdated),
    ...(device.binaryControl ? { binaryOn: device.binaryControl.on } : {}),
    targets: device.targets.map((target) => ({ id: target.id, unit: target.unit, ...present('value', target.value) })),
    ...(device.controlAdapter ? {
      controlAdapter: {
        kind: device.controlAdapter.kind,
        activationRequired: device.controlAdapter.activationRequired,
        activationEnabled: device.controlAdapter.activationEnabled,
        ...present('currentControl', device.controlAdapter.currentControl),
        ...present('activationAvailable', device.controlAdapter.activationAvailable),
      },
    } : {}),
    ...reportDeviceMeasurements(device),
    ...(isSteppedLoadSnapshot(device) ? {
      steps: device.steppedLoadProfile.steps.map((step) => ({
        id: step.id, planningPowerW: step.planningPowerW, ...present('planningCurrentA', step.planningCurrentA),
      })),
    } : {}),
  },
});

export const reportDeviceDecision = (device: DevicePlanDevice): SupportReportSection => ({
  title: 'Current device plan',
  values: {
    plannedState: device.plannedState,
    currentState: device.currentState,
    reasonCode: device.reason.code,
    priority: device.priority,
    // Whether PELS may command it this cycle, and which standing hold keeps it
    // off: without these a held charger reads the same as a broken one.
    commandAuthority: device.control.commandAuthority,
    ...present('startPolicyHoldActive', device.startPolicyHoldActive),
    ...present('chargeTargetHeld', device.chargeTargetHeld?.kind),
    ...present('desiredStepId', device.desiredStepId),
    ...present('lastDesiredStepId', device.lastDesiredStepId),
    ...present('reportedStepId', device.reportedStepId),
    ...present('lastStepCommandIssuedAtMs', device.lastStepCommandIssuedAt),
    ...present('stepCommandStatus', device.stepCommandStatus),
    ...(isTemperaturePlanDevice(device) ? {
      currentTemperatureC: device.currentTemperature,
      currentTargetC: device.currentTarget,
      plannedTargetC: device.plannedTarget,
    } : {}),
  },
});

export const reportDevicePresentation = (device: SettingsUiPlanDeviceSnapshot): SupportReportSection => ({
  title: 'Current device status',
  values: {
    state: device.status.kind, label: device.status.label, power: device.status.powerText,
    fact: device.status.factText, reason: device.status.reason?.text ?? null,
    limited: device.status.limited, wouldLimit: device.status.wouldLimit,
  },
});

export const reportHomePlan = (plan: SettingsUiPlanSnapshot): SupportReportSection => ({
  title: 'Current home plan',
  values: {
    ...present('planGeneratedAtMs', plan.generatedAtMs),
    ...(plan.meta ? {
      powerKw: plan.meta.totalKw,
      powerIsMeasured: plan.meta.powerIsMeasured,
      powerObservedAtMs: plan.meta.lastPowerUpdateMs,
      capacityPaceKw: plan.meta.capacitySoftLimitKw,
      budgetPaceKw: plan.meta.budgetPaceKw,
      gridImportLimitKw: plan.meta.gridImportLimitKw,
      gridImportTargetKw: plan.meta.gridImportTargetKw,
      limitingConstraint: plan.meta.softLimitSource,
      usedKWh: plan.meta.usedKWh,
      hourBudgetKWh: plan.meta.hourBudgetKWh,
      capacityPeriodMinutes: plan.meta.capacityPeriodMinutes,
    } : {}),
  },
});

export const reportCapacitySettings = (settings: CapacityScalarSettings): SupportReportSection => ({
  title: 'Current limits settings',
  values: {
    capacityEnabled: settings.capacityEnabled, hardCapKw: settings.limitKw,
    safetyMarginKw: settings.marginKw, capacityPeriodMinutes: settings.periodMinutes,
    gridImportLimitKw: settings.gridImportLimitKw, simulation: settings.dryRun,
  },
});

export const reportDailyBudget = (day: DailyBudgetDayPayload): SupportReportSection => ({
  title: 'Current daily budget',
  values: {
    date: day.dateKey, timeZone: day.timeZone, updatedAt: day.nowUtc,
    enabled: day.budget.enabled, dailyBudgetKWh: day.budget.dailyBudgetKWh,
    priceShapingEnabled: day.budget.priceShapingEnabled,
    usedKWh: day.state.usedNowKWh, allowedKWh: day.state.allowedNowKWh,
    remainingKWh: day.state.remainingKWh, exceeded: day.state.exceeded,
  },
});

const reportCarStatus = (car: CarLinkCarStatus): Record<string, SupportReportValue> => {
  switch (car.availability) {
    case 'observed': return {
      availability: car.availability, carId: car.carId, carName: car.carName, state: car.state,
      stateReportedAtMs: car.stateReportedAtMs, pastMatches: car.pastMatches,
    };
    case 'outage':
    case 'unread': return {
      availability: car.availability, carId: car.carId, carName: car.carName, pastMatches: car.pastMatches,
    };
    case 'unknown': return { availability: car.availability, carId: car.carId, pastMatches: car.pastMatches };
    default: return car satisfies never;
  }
};

export const reportCarLink = (link: CarLinkDiagnostics): SupportReportSection => ({
  title: 'Current car link',
  values: link.role === 'charger' ? {
    role: 'charger',
    selection: link.selection,
    cars: link.cars.map(reportCarStatus),
    ...present('connection', link.connection && { atMs: link.connection.atMs, seen: link.connection.seen }),
    ...present('associatedCar', link.associatedCar
      && { carId: link.associatedCar.carId, carName: link.associatedCar.carName }),
    ...present('confirmedCar', link.confirmedCar
      && { carId: link.confirmedCar.carId, carName: link.confirmedCar.carName }),
    ...present('waitingSinceMs', link.waitingSinceMs),
  } : {
    role: 'car',
    chargerIds: [...link.chargerIds],
    ...present('associatedChargerId', link.associatedChargerId),
  },
});

/**
 * The fields of a task's recorded plan the report states: its decision, the
 * learned rate behind it and the latest revision. Narrowed so a capture hands
 * over one device's record, never the assembled UI view of every task.
 */
export type SupportReportSmartTaskPlan = Pick<DeferredObjectiveActivePlanV1,
  'pending' | 'pendingReason' | 'diagnosticReasonCode' | 'kwhPerUnitProvenance'> & {
  latest: Pick<DeferredObjectiveActivePlanRevisionV1,
    'planStatus' | 'energyNeededKWh' | 'hours' | 'revisedAtMs' | 'reason' | 'floorShortfallCause'> | null;
};

/** The subject device's smart task as capture read it. An unreadable store throws instead. */
export type SupportReportSmartTask =
  | { state: 'none' }
  | {
    state: 'present';
    entry: DeferredObjectiveSettingsEntry;
    /** `undefined` when the planner holds no plan for the task yet. */
    plan: SupportReportSmartTaskPlan | undefined;
    /** `undefined` before the controller's first cycle with this task. */
    cycle: SmartTaskCycleRecord | undefined;
  };

const reportSmartTaskGoal = (entry: DeferredObjectiveSettingsEntry): Record<string, SupportReportValue> => {
  if (entry.kind === 'ev_soc') return { targetPercent: entry.targetPercent };
  if (entry.kind === 'temperature') return { targetTemperatureC: entry.targetTemperatureC };
  return { targetEnergyKWh: entry.targetEnergyKWh };
};

const reportSmartTaskRevision = (
  revision: NonNullable<SupportReportSmartTaskPlan['latest']>,
  capturedAtMs: number,
): Record<string, SupportReportValue> => {
  // Saved hours are bookings; a booking at 0 kWh still lets the task start its
  // device, so whether this hour is booked is reported apart from its energy.
  const running = hoursWithPlannedEnergy(revision.hours);
  const currentHour = revision.hours.find((hour) => (
    (hour.coversFromMs ?? hour.startsAtMs) <= capturedAtMs && capturedAtMs < hour.endsAtMs
  ));
  const nextHour = running.find((hour) => hour.startsAtMs > capturedAtMs);
  return {
    planStatus: revision.planStatus,
    revisedAtMs: revision.revisedAtMs,
    revisionReason: revision.reason,
    energyNeededKWh: revision.energyNeededKWh,
    ...present('floorShortfallCause', revision.floorShortfallCause),
    plannedHours: plannedDurationHours(revision.hours),
    currentHourBooked: currentHour !== undefined,
    ...present('currentHourPlannedKWh', currentHour?.plannedKWh),
    ...present('nextPlannedHourStartsAtMs', nextHour?.startsAtMs),
  };
};

const reportSmartTaskPlan = (
  plan: SupportReportSmartTaskPlan,
  capturedAtMs: number,
): Record<string, SupportReportValue> => ({
  pending: plan.pending,
  ...present('pendingReason', plan.pendingReason),
  ...present('diagnosticReasonCode', plan.diagnosticReasonCode),
  ...(plan.kwhPerUnitProvenance ? {
    learnedRateSource: plan.kwhPerUnitProvenance.source,
    learnedRateSamples: plan.kwhPerUnitProvenance.acceptedSamples,
    ...present('learnedRateConfidence', plan.kwhPerUnitProvenance.confidence ?? undefined),
  } : {}),
  ...(plan.latest ? reportSmartTaskRevision(plan.latest, capturedAtMs) : { revision: 'none' }),
});

// The controller's latest decision: `planned` lets the task start its device,
// `idle` holds it (`holdCause`), `inactive` names the missing precondition in
// `reasonCode`. This is what a report on "why does it not run" turns on.
const reportSmartTaskCycle = (cycle: SmartTaskCycleRecord): Record<string, SupportReportValue> => ({
  atMs: cycle.atMs,
  decision: cycle.decision,
  ...present('holdCause', cycle.holdCause),
  reasonCode: cycle.reasonCode,
  trajectory: cycle.trajectory,
  currentValue: cycle.currentValue,
  energyNeededKWh: cycle.energyNeededKWh,
  planningSpeedKw: cycle.planningSpeedKw,
  kwhPerUnitSource: cycle.kwhPerUnitSource,
  kwhPerUnitAcceptedSamples: cycle.kwhPerUnitAcceptedSamples,
  budgetExempt: cycle.budgetExempt,
  ...present('engageBoost', cycle.engageBoost),
  ...present('reservesStartupPower', cycle.reservesStartupPower),
  ...present('liveStepsUnavailable', cycle.liveStepsUnavailable),
});

/**
 * Whether the subject has a smart task, what the planner recorded for it and
 * what the controller decided last cycle. "No smart task" is evidence too: a
 * device held by "Only PELS starts this device" without one is off by design,
 * which nothing else in a report says.
 */
export const reportSmartTask = (read: SupportReportSmartTask, capturedAtMs: number): SupportReportSection => {
  if (read.state === 'none') return { title: 'Current smart task', values: { exists: false } };
  const { entry, plan, cycle } = read;
  return {
    title: 'Current smart task',
    values: {
      exists: true,
      kind: entry.kind,
      enabled: entry.enabled,
      enforcement: entry.enforcement,
      deadlineAtMs: entry.deadlineAtMs,
      ...reportSmartTaskGoal(entry),
      plan: plan ? reportSmartTaskPlan(plan, capturedAtMs) : 'none',
      lastCycle: cycle ? reportSmartTaskCycle(cycle) : 'none',
    },
  };
};

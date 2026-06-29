import type {
  DeviceDiagnosticsControlEvent,
  LiveDemandObservation,
} from './deviceDiagnosticsServiceTypes';
import type { StructuredDebugEmitter } from '../logging/logger';

type DemandTransition = {
  deviceId: string;
  name: string;
  previous: LiveDemandObservation | undefined;
  next: LiveDemandObservation;
  previousUnmet: boolean;
  nextUnmet: boolean;
};

export const logObservationTransition = (
  emit: StructuredDebugEmitter,
  deviceId: string,
  name: string,
  previous: LiveDemandObservation | undefined,
  next: LiveDemandObservation,
): void => {
  const previousUnmet = previous?.includeDemandMetrics === true && previous.unmetDemand;
  const nextUnmet = next.includeDemandMetrics && next.unmetDemand;
  const transition: DemandTransition = {
    deviceId,
    name,
    previous,
    next,
    previousUnmet,
    nextUnmet,
  };
  logDemandBoundary(emit, transition);
  logBlockCauseChange(emit, transition);
};

const logDemandBoundary = (emit: StructuredDebugEmitter, transition: DemandTransition): void => {
  const {
    deviceId,
    name,
    previous,
    next,
    previousUnmet,
    nextUnmet,
  } = transition;
  if (!previousUnmet && nextUnmet) {
    emit({
      event: 'diagnostics_unmet_demand_started',
      deviceId,
      deviceName: name,
      desired: next.desiredStateSummary,
      applied: next.appliedStateSummary,
      cause: next.blockCause,
    });
    return;
  }
  if (!previousUnmet || nextUnmet) return;
  emit({
    event: 'diagnostics_unmet_demand_ended',
    deviceId,
    deviceName: name,
    desired: previous?.desiredStateSummary ?? 'unknown',
    applied: previous?.appliedStateSummary ?? 'unknown',
  });
};

const logBlockCauseChange = (emit: StructuredDebugEmitter, transition: DemandTransition): void => {
  const {
    deviceId,
    name,
    previous,
    next,
    previousUnmet,
    nextUnmet,
  } = transition;
  const previousCause = previousUnmet ? previous?.blockCause : 'not_blocked';
  const nextCause = nextUnmet ? next.blockCause : 'not_blocked';
  if (!(previousUnmet || nextUnmet) || previousCause === nextCause) return;
  emit({
    event: 'diagnostics_block_cause_changed',
    deviceId,
    deviceName: name,
    desired: next.desiredStateSummary,
    applied: next.appliedStateSummary,
    previousCause: previousCause ?? 'not_blocked',
    nextCause,
  });
};

export const logTrackedUsageEvent = (
  emit: StructuredDebugEmitter,
  direction: 'rise' | 'drop',
  event: Extract<DeviceDiagnosticsControlEvent, { kind: 'tracked_usage_rise' | 'tracked_usage_drop' }>,
  deviceName: string,
): void => {
  emit({
    event: 'diagnostics_tracked_usage',
    direction,
    deviceId: event.deviceId,
    deviceName,
    fromKw: event.fromKw,
    toKw: event.toKw,
    ...(event.reconciliation ? { reconciliation: event.reconciliation } : {}),
  });
};

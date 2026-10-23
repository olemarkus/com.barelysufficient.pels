import type {
  DeviceDiagnosticsControlEvent,
  LiveDemandObservation,
} from './deviceDiagnosticsServiceTypes';
import { getDebugEmitter } from '../logging/logger';

const debug = getDebugEmitter('diagnostics', 'diagnostics');

type DemandTransition = {
  deviceId: string;
  name: string;
  previous: LiveDemandObservation | undefined;
  next: LiveDemandObservation;
  previousUnmet: boolean;
  nextUnmet: boolean;
};

export const logObservationTransition = (
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
  logDemandBoundary(transition);
  logBlockCauseChange(transition);
};

const logDemandBoundary = (transition: DemandTransition): void => {
  const {
    deviceId,
    name,
    previous,
    next,
    previousUnmet,
    nextUnmet,
  } = transition;
  if (!previousUnmet && nextUnmet) {
    debug({
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
  debug({
    event: 'diagnostics_unmet_demand_ended',
    deviceId,
    deviceName: name,
    desired: previous?.desiredStateSummary ?? 'unknown',
    applied: previous?.appliedStateSummary ?? 'unknown',
  });
};

const logBlockCauseChange = (transition: DemandTransition): void => {
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
  debug({
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
  direction: 'rise' | 'drop',
  event: Extract<DeviceDiagnosticsControlEvent, { kind: 'tracked_usage_rise' | 'tracked_usage_drop' }>,
  deviceName: string,
): void => {
  debug({
    event: 'diagnostics_tracked_usage',
    direction,
    deviceId: event.deviceId,
    deviceName,
    fromKw: event.fromKw,
    toKw: event.toKw,
    ...(event.reconciliation ? { reconciliation: event.reconciliation } : {}),
  });
};

import type { DeviceDiagnosticsTrackedTransitionReconciliation } from '../diagnostics/deviceDiagnosticsService';
import { RESTORE_COOLDOWN_MS, SHED_COOLDOWN_MS } from './planConstants';
import type { HeadroomCardState, PlanEngineState } from './planState';
import { isFiniteNumber } from '../utils/appTypeGuards';

export { isFiniteNumber };

export type HeadroomCardCooldownSource = 'pels_shed' | 'pels_restore';
export type HeadroomDeviceKwSource = 'expectedPowerKw' | 'powerKw' | 'measuredPowerKw' | 'fallback_zero';
export type ResolvedHeadroomDeviceKw = { kw: number; source: HeadroomDeviceKwSource };
export type HeadroomTrackedTransitionContext = Extract<
  DeviceDiagnosticsTrackedTransitionReconciliation,
  'snapshot_refresh'
>;

const TRACKED_TRANSITION_RECONCILIATION_WINDOW_MS = Math.max(
  SHED_COOLDOWN_MS,
  RESTORE_COOLDOWN_MS,
);

export type HeadroomCardDeviceLike = {
  id: string;
  name: string;
  powerKw?: number;
  expectedPowerKw?: number;
  measuredPowerKw?: number;
  currentOn: boolean;
  currentState?: string;
  available?: boolean;
};

export type HeadroomCooldownCandidate = {
  source: HeadroomCardCooldownSource;
  remainingSec: number;
  expiresAtMs: number;
  startMs: number;
  dropFromKw: number | null;
  dropToKw: number | null;
};

const isWithinReconciliationWindow = (
  startMs: number | undefined,
  nowTs: number,
  windowMs: number,
): boolean => (
  isFiniteNumber(startMs)
  && nowTs >= startMs
  && nowTs <= startMs + windowMs
);

const getStartupReconciliationWindowEndMs = (state: PlanEngineState): number => (
  isFiniteNumber(state.startupRestoreBlockedUntilMs)
    ? state.startupRestoreBlockedUntilMs
    : state.appStartedAtMs + TRACKED_TRANSITION_RECONCILIATION_WINDOW_MS
);

export const ensureHeadroomEntry = (
  state: PlanEngineState,
  deviceId: string,
): HeadroomCardState => {
  const cards = state.headroomCardByDevice;
  if (!cards[deviceId]) {
    cards[deviceId] = {};
  }
  return cards[deviceId];
};

export const updateHeadroomCardLastObserved = (
  state: PlanEngineState,
  deviceId: string,
  trackedKw: number,
  trackedKwSource: HeadroomDeviceKwSource,
  deviceName?: string,
): void => {
  const entry = ensureHeadroomEntry(state, deviceId);
  entry.lastObservedKw = trackedKw;
  entry.lastObservedKwSource = trackedKwSource;
  if (deviceName) {
    entry.deviceName = deviceName;
  }
};

export const resolveHeadroomDeviceName = (params: {
  state: PlanEngineState;
  deviceId: string;
  device?: Pick<HeadroomCardDeviceLike, 'name'>;
  deviceName?: string;
}): string | undefined => (
  params.device?.name
  ?? params.deviceName
  ?? params.state.headroomCardByDevice[params.deviceId]?.deviceName
);

export const resolveTrackedTransitionReconciliation = (params: {
  state: PlanEngineState;
  deviceId: string;
  nowTs: number;
  context?: HeadroomTrackedTransitionContext;
}): DeviceDiagnosticsTrackedTransitionReconciliation | undefined => {
  const { state, deviceId, nowTs, context } = params;
  if (context === 'snapshot_refresh') return context;
  if (
    isFiniteNumber(state.appStartedAtMs)
    && nowTs >= state.appStartedAtMs
    && nowTs <= getStartupReconciliationWindowEndMs(state)
  ) {
    return 'startup';
  }
  if (
    isWithinReconciliationWindow(
      state.lastDeviceShedMs[deviceId],
      nowTs,
      TRACKED_TRANSITION_RECONCILIATION_WINDOW_MS,
    )
    || isWithinReconciliationWindow(
      state.lastDeviceRestoreMs[deviceId],
      nowTs,
      TRACKED_TRANSITION_RECONCILIATION_WINDOW_MS,
    )
  ) {
    return 'post_actuation';
  }
  return undefined;
};

export const resolveTrackedHeadroomDeviceKw = (
  device: Pick<HeadroomCardDeviceLike, 'expectedPowerKw' | 'powerKw'>,
): ResolvedHeadroomDeviceKw => {
  if (isFiniteNumber(device.expectedPowerKw)) return { kw: device.expectedPowerKw, source: 'expectedPowerKw' };
  if (isFiniteNumber(device.powerKw)) return { kw: device.powerKw, source: 'powerKw' };
  return { kw: 0, source: 'fallback_zero' };
};

export const resolveObservedHeadroomDeviceKw = (
  device: Pick<HeadroomCardDeviceLike, 'measuredPowerKw' | 'powerKw'>,
): ResolvedHeadroomDeviceKw => {
  if (isFiniteNumber(device.measuredPowerKw)) return { kw: device.measuredPowerKw, source: 'measuredPowerKw' };
  if (isFiniteNumber(device.powerKw)) return { kw: device.powerKw, source: 'powerKw' };
  return { kw: 0, source: 'fallback_zero' };
};

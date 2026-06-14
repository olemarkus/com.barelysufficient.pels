import type { DeviceDiagnosticsTrackedTransitionReconciliation } from '../diagnostics/deviceDiagnosticsService';
import { RESTORE_COOLDOWN_MS, SHED_COOLDOWN_MS } from './planConstants';
import type { HeadroomCardState, PlanEngineState } from './planState';
import { isFiniteNumber } from '../utils/appTypeGuards';
import { resolveCurrentOn } from '../observer/observedState';
import type { BinaryControlCapabilityId, SteppedLoadProfile } from '../../packages/contracts/src/types';

export { isFiniteNumber };

type RawHeadroomDevice = {
  controlCapabilityId?: BinaryControlCapabilityId;
  binaryControl?: { on: boolean };
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
};

/**
 * Stamp the producer-resolved `currentOn` onto a raw snapshot-shaped device for
 * the headroom/activation path (mirrors `toPlanDevice`): present iff binary,
 * resolved from the binary + stepped-off inputs. The seams that feed raw
 * snapshots (realtime snapshot-refresh in `appSnapshotHelpers`, the Flow headroom
 * card) carry no `currentOn` otherwise, so the activation in/active reads would
 * mis-detect a device that turned off/on mid-window.
 */
export function withHeadroomCurrentOn<T extends RawHeadroomDevice>(device: T): T & { currentOn?: boolean } {
  return device.controlCapabilityId !== undefined
    ? { ...device, currentOn: resolveCurrentOn(device) }
    : device;
}

export type HeadroomCardCooldownSource = 'pels_shed' | 'pels_restore';
export type HeadroomUsageObservation = { kw: number; freshnessMs?: number };
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
  lastFreshDataMs?: number;
  binaryControl?: { on: boolean };
  // Producer-resolved on/off truth (present iff binary). The activation in/active
  // reads consume this; the seams that feed raw snapshots (appSnapshotHelpers,
  // the Flow headroom card) stamp it before the device reaches this path. A
  // step-only stepper carries no `currentOn`; the activation reads resolve its
  // on/off from the step axis, so the stepped fields travel with it.
  currentOn?: boolean;
  currentState?: string;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
  available?: boolean;
};

export type HeadroomCooldownCandidate = {
  source: HeadroomCardCooldownSource;
  remainingSec: number;
  expiresAtMs: number;
  startMs: number;
  totalSec: number;
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

export const updateHeadroomCardUsageObservation = (params: {
  state: PlanEngineState;
  deviceId: string;
  usageObservation: HeadroomUsageObservation;
  deviceName?: string;
}): void => {
  const {
    state,
    deviceId,
    usageObservation,
    deviceName,
  } = params;
  const entry = ensureHeadroomEntry(state, deviceId);
  entry.lastUsageKw = usageObservation.kw;
  if (isFiniteNumber(usageObservation.freshnessMs)) {
    entry.lastUsageFreshnessMs = usageObservation.freshnessMs;
  } else {
    delete entry.lastUsageFreshnessMs;
  }
  if (deviceName) {
    entry.deviceName = deviceName;
  }
};

export type UsageObservationMergeOutcome = 'lose' | 'tie' | 'tie_refresh' | 'win';

export type TrackedUsageMergeDecision = {
  outcome: UsageObservationMergeOutcome;
};

export const resolveUsageObservationMergeDecision = (params: {
  entry?: Pick<HeadroomCardState, 'lastUsageKw' | 'lastUsageFreshnessMs'>;
  usageObservation: HeadroomUsageObservation;
}): TrackedUsageMergeDecision => {
  const {
    entry,
    usageObservation,
  } = params;
  const previousUsageKw = entry?.lastUsageKw;
  const previousUsageFreshnessMs = entry?.lastUsageFreshnessMs;
  const incomingUsageFreshnessMs = usageObservation.freshnessMs;
  const hasPreviousFreshness = isFiniteNumber(previousUsageFreshnessMs);
  const hasIncomingFreshness = isFiniteNumber(incomingUsageFreshnessMs);

  if (hasPreviousFreshness && !hasIncomingFreshness) {
    return { outcome: 'lose' };
  }

  if (
    hasPreviousFreshness
    && hasIncomingFreshness
    && incomingUsageFreshnessMs < previousUsageFreshnessMs
  ) {
    return { outcome: 'lose' };
  }

  const semanticNoop = previousUsageKw === usageObservation.kw;
  if (semanticNoop) {
    if (
      hasIncomingFreshness
      && (!hasPreviousFreshness || incomingUsageFreshnessMs > previousUsageFreshnessMs)
    ) {
      return { outcome: 'tie_refresh' };
    }
    return { outcome: 'tie' };
  }

  return { outcome: 'win' };
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


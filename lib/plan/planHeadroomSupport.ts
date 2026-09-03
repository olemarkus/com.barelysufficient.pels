import type { DeviceDiagnosticsTrackedTransitionReconciliation } from '../diagnostics/deviceDiagnosticsService';
import { RESTORE_COOLDOWN_MS, SHED_COOLDOWN_MS } from './planConstants';
import type { HeadroomCardState, PlanEngineState } from './planState';
import { hasBinaryControlCapability } from '../../packages/shared-domain/src/binaryControlKind';
import { isFiniteNumber } from '../utils/appTypeGuards';
import { resolveCurrentOn } from '../observer/observedState';
import { getCurrentDrawKw } from '../observer/observedPower';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

export { isFiniteNumber };

type RawHeadroomDevice = {
  // Owner-side optional: this is still a transport snapshot at this seam, and
  // resolving that absence away is exactly what `getCurrentDrawKw`
  // (`lib/observer/observedPower.ts`) is for.
  measuredPowerKw?: number;
  binaryControl?: { on: boolean };
  currentOn?: boolean;
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
export function withHeadroomCurrentOn<T extends RawHeadroomDevice>(
  device: T,
): T & { currentOn?: boolean; currentDrawKw: number } {
  // The sample path's producer boundary — the twin of `toPlanDevice` for devices
  // that reach the usage math straight off the transport. Resolve the draw here
  // so nothing below has to look at the raw reading.
  //
  const currentDrawKw = getCurrentDrawKw(device);
  return hasBinaryControlCapability(device)
    ? { ...device, currentDrawKw, currentOn: resolveCurrentOn(device) }
    : { ...device, currentDrawKw };
}

export type HeadroomCardCooldownSource = 'pels_shed' | 'pels_restore';
export type HeadroomUsageObservation = { kw: number };
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
  expectedPowerKw?: number;
  currentDrawKw: number;
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
  if (deviceName) {
    entry.deviceName = deviceName;
  }
};

export type UsageObservationMergeOutcome = 'tie' | 'win';

export type TrackedUsageMergeDecision = {
  outcome: UsageObservationMergeOutcome;
};

// The draw alone decides. This used to compare the incoming observation's
// timestamp against the stored one and drop an older or unstamped reading — the
// planner second-guessing the order the observer handed it values in, which is
// the provenance branch the root `AGENTS.md` forbids. The observer publishes the
// trusted current value; an unchanged value is a no-op, a changed one is news.
export const resolveUsageObservationMergeDecision = (params: {
  entry?: Pick<HeadroomCardState, 'lastUsageKw'>;
  usageObservation: HeadroomUsageObservation;
}): TrackedUsageMergeDecision => {
  const { entry, usageObservation } = params;
  return entry?.lastUsageKw === usageObservation.kw
    ? { outcome: 'tie' }
    : { outcome: 'win' };
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

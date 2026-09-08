import type { DeviceDiagnosticsTrackedTransitionReconciliation } from '../diagnostics/deviceDiagnosticsService';
import { RESTORE_COOLDOWN_MS, SHED_COOLDOWN_MS } from './planConstants';
import type { HeadroomCardState, PlanEngineState } from './planState';
import { hasBinaryControlCapability } from '../../packages/shared-domain/src/binaryControlKind';
import { isFiniteNumber } from '../utils/appTypeGuards';
import { resolveCurrentOn } from '../observer/observedState';
import { getCurrentDrawKw } from '../observer/observedPower';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { ActivationBackoffObservation } from './admission/activationBackoff';

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

const TRACKED_TRANSITION_RECONCILIATION_WINDOW_MS = Math.max(
  SHED_COOLDOWN_MS,
  RESTORE_COOLDOWN_MS,
);

/**
 * A device as the headroom card and the activation reads see it: the activation
 * observation plus identity. Both a plan device and a stamped snapshot device
 * (`withHeadroomCurrentOn`) are one of these.
 */
export type HeadroomCardDeviceLike = ActivationBackoffObservation & {
  id: string;
  name: string;
  expectedPowerKw?: number;
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

/**
 * The reconciliation a tracked usage change happened under, read off the plan
 * state: the startup window, or the window after PELS itself actuated the
 * device. A caller that knows a better label (the snapshot refresh) stamps it
 * instead of asking.
 */
export const resolveTrackedTransitionReconciliation = (
  state: PlanEngineState,
  deviceId: string,
  nowTs: number,
): DeviceDiagnosticsTrackedTransitionReconciliation | undefined => {
  if (
    isFiniteNumber(state.appStartedAtMs)
    && nowTs >= state.appStartedAtMs
    && nowTs <= getStartupReconciliationWindowEndMs(state)
  ) {
    return 'startup';
  }
  if (
    isWithinReconciliationWindow(
      state.actuation.lastDeviceShedMs[deviceId],
      nowTs,
      TRACKED_TRANSITION_RECONCILIATION_WINDOW_MS,
    )
    || isWithinReconciliationWindow(
      state.actuation.lastDeviceRestoreMs[deviceId],
      nowTs,
      TRACKED_TRANSITION_RECONCILIATION_WINDOW_MS,
    )
  ) {
    return 'post_actuation';
  }
  return undefined;
};

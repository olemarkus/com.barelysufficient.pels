import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import type { PlanEngineState } from './planState';

export type ResolvedModeTargetSeed =
  | { kind: 'mode'; value: number }
  /** Mode target missing but a pre-shed anchor is owed and the device still
   * sits at its captured shed floor: the anchor is the intended target
   * (`lib/plan/preShedAnchor.ts`). Unmodulated, like `fallback`. */
  | { kind: 'anchor'; value: number }
  | { kind: 'fallback'; value: number };

// Per-device emit-on-first-occurrence + N-minute heartbeat for the
// `missing_mode_target` debug event. The emit gate already requires the `plan`
// debug topic (off by default), but when users enable it a stuck misconfigured
// device would otherwise fire one log line per plan cycle (~10 s in
// `homey_energy` mode → ~8,640/day). Matches the 15-minute window used by
// `STALE_OBSERVATION_REFRESH_LOG_BACKOFF_MS` in `setup/appSnapshotHelpers.ts`.
// In-memory only per `feedback_homey_sdk_unreliable`.
export const MISSING_MODE_TARGET_EMIT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Drop per-device transient state for devices no longer present in the live
 * snapshot. Mirrors `cleanupMissingHeadroomDevices` in `planHeadroomState.ts`
 * and the proactive prune in `setup/appSnapshotHelpers.ts:pruneStaleRefreshLogBackoff`.
 * Returns true when at least one entry was deleted.
 */
export function cleanupMissingModeTargetDevices(
  state: PlanEngineState,
  currentDeviceIds: ReadonlySet<string> | readonly string[],
): boolean {
  const activeIds = currentDeviceIds instanceof Set
    ? currentDeviceIds
    : new Set(currentDeviceIds);
  let removed = false;
  for (const deviceId of Object.keys(state.modeTargetMissingByDevice)) {
    if (activeIds.has(deviceId)) continue;
    // eslint-disable-next-line no-param-reassign -- shared plan engine state update
    delete state.modeTargetMissingByDevice[deviceId];
    removed = true;
  }
  return removed;
}

/**
 * Mode target is set this cycle: wipe the emit throttle so a future transition
 * back into missing emits immediately.
 */
export function clearMissingModeEmitState(
  state: PlanEngineState,
  deviceId: string,
): void {
  if (state.modeTargetMissingByDevice[deviceId] === undefined) return;
  // eslint-disable-next-line no-param-reassign -- shared plan engine state update
  delete state.modeTargetMissingByDevice[deviceId];
}

/**
 * Resolve the temperature seed when the mode target is missing (user config
 * absence — the only remaining miss: the capability value itself is guaranteed
 * finite by the observer's atomic temperature facet, so there is no transient-
 * read grace window and no skip state). Falls back to the device's own current
 * setpoint and emits the throttled `missing_mode_target` diagnostic.
 */
export function resolveMissingModeTargetSeed(params: {
  state: PlanEngineState;
  deviceId: string;
  /** The device's current target setpoint — the atomic facet's finite value. */
  capabilityValue: number;
  payload: Record<string, unknown>;
  debugStructured?: StructuredDebugEmitter;
  logger: PinoLogger;
}): ResolvedModeTargetSeed {
  const { state, deviceId, capabilityValue, payload, debugStructured, logger } = params;
  emitMissingModeTargetThrottled({
    state, deviceId, payload, nowMs: Date.now(), debugStructured, logger,
  });
  return { kind: 'fallback', value: capabilityValue };
}

/**
 * Per-device emit gating for `missing_mode_target`. Emit on (a) first
 * occurrence or (b) heartbeat interval elapsed. Same pattern as
 * `setup/appSnapshotHelpers.ts:STALE_OBSERVATION_REFRESH_LOG_BACKOFF_MS`.
 * Returns true when an emit was actually fired (the caller doesn't need it,
 * but it's useful for tests and future caller introspection).
 */
function emitMissingModeTargetThrottled(params: {
  state: PlanEngineState;
  deviceId: string;
  payload: Record<string, unknown>;
  nowMs: number;
  debugStructured?: StructuredDebugEmitter;
  logger: PinoLogger;
}): boolean {
  const { state, deviceId, payload, nowMs, debugStructured, logger } = params;
  const lastEmitMs = state.modeTargetMissingByDevice[deviceId]?.lastEmitAtMs;
  const shouldEmit = lastEmitMs === undefined
    || (nowMs - lastEmitMs) >= MISSING_MODE_TARGET_EMIT_INTERVAL_MS;
  if (!shouldEmit) return false;
  state.modeTargetMissingByDevice[deviceId] = { lastEmitAtMs: nowMs };
  if (debugStructured) {
    debugStructured({ event: 'missing_mode_target', ...payload });
  } else {
    logger.debug({ event: 'missing_mode_target', ...payload });
  }
  return true;
}

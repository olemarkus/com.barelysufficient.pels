import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import type { PlanEngineState } from './planState';

export type ResolvedModeTargetSeed =
  | { kind: 'mode'; value: number }
  | { kind: 'fallback'; value: number }
  | { kind: 'grace_fallback'; value: number }
  | { kind: 'skip' };

// Abandon-grace for the mode-target capability read: tolerate transient Homey
// SDK misses on `getPrimaryTargetCapability(dev.targets)?.value` for up to
// `MODE_TARGET_GRACE_CYCLES` consecutive cycles before falling through to the
// existing skip path. Within the grace window we reuse the last successfully
// resolved capability value (cached per device in `PlanEngineState`). Per
// `feedback_homey_sdk_unreliable`, capability reads can transiently fail during
// cold-start, re-pair, or zone reload; in `homey_energy` mode plan cycles run
// every ~10 s, so 4 cycles covers roughly 40 s — long enough to ride out a
// transient miss without indefinitely planning against a stale value.
export const MODE_TARGET_GRACE_CYCLES = 4;

// Per-device emit-on-transition + N-minute heartbeat for the
// `missing_mode_target` / `missing_mode_target_and_current_target` debug events.
// The emit gate already requires the `plan` debug topic (off by default), but
// when users enable it a stuck misconfigured device would otherwise fire one
// log line per plan cycle (~10 s in `homey_energy` mode → ~8,640/day). Matches
// the 15-minute window used by `STALE_OBSERVATION_REFRESH_LOG_BACKOFF_MS` in
// `lib/app/appSnapshotHelpers.ts`. In-memory only per
// `feedback_homey_sdk_unreliable`.
export const MISSING_MODE_TARGET_EMIT_INTERVAL_MS = 15 * 60 * 1000;

type MissingModeTargetEvent =
  | 'missing_mode_target'
  | 'missing_mode_target_and_current_target';

/**
 * Refresh the cached capability value after a successful read. Keeps emit
 * throttle metadata so a `missing_mode_target` fallback event that was just
 * emitted does not immediately re-emit on the next still-missing-mode cycle.
 *
 * The capability ID is stored alongside the value so the grace path can
 * invalidate the cache when the primary target capability changes (e.g. a
 * re-pair swaps `target_temperature` for a different capability).
 */
export function rememberModeTargetCapability(
  state: PlanEngineState,
  deviceId: string,
  cachedValue: number,
  cachedCapabilityId: string | undefined,
): void {
  const existing = state.modeTargetMissingByDevice[deviceId];
  // eslint-disable-next-line no-param-reassign -- shared plan engine state update
  state.modeTargetMissingByDevice[deviceId] = {
    ...(existing ?? {}),
    missingCycles: 0,
    cachedTargetValue: cachedValue,
    cachedTargetCapabilityId: cachedCapabilityId,
  };
}

/**
 * Drop per-device transient state for devices no longer present in the live
 * snapshot. Mirrors `cleanupMissingHeadroomDevices` in `planHeadroomState.ts`
 * and the proactive prune in `lib/app/appSnapshotHelpers.ts:pruneStaleRefreshLogBackoff`.
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
 * Mode target is set this cycle: wipe grace counter and emit throttle so a
 * future transition back into missing emits immediately. Preserves the cached
 * capability value (still the last known good read) for the double-miss case.
 */
export function clearMissingModeEmitState(
  state: PlanEngineState,
  deviceId: string,
): void {
  const existing = state.modeTargetMissingByDevice[deviceId];
  if (existing === undefined) return;
  if (existing.cachedTargetValue === undefined) {
    // eslint-disable-next-line no-param-reassign -- shared plan engine state update
    delete state.modeTargetMissingByDevice[deviceId];
    return;
  }
  // eslint-disable-next-line no-param-reassign -- shared plan engine state update
  state.modeTargetMissingByDevice[deviceId] = {
    missingCycles: 0,
    cachedTargetValue: existing.cachedTargetValue,
    ...(existing.cachedTargetCapabilityId !== undefined
      ? { cachedTargetCapabilityId: existing.cachedTargetCapabilityId }
      : {}),
  };
}

type GraceEvaluation =
  | { kind: 'grace_fallback'; value: number }
  | { kind: 'skip' };

/**
 * Resolve the temperature seed when the mode target is missing. Applies the
 * abandon-grace window first; if grace is available the caller skips emitting
 * `missing_mode_target_and_current_target`. When grace is exhausted (or there
 * is no cached capability value), falls through to the existing skip path and
 * emits the throttled event.
 */
export function resolveMissingModeTargetSeed(params: {
  state: PlanEngineState;
  deviceId: string;
  capabilityValue: number | undefined;
  /**
   * Capability ID of the primary target this cycle. When present, must match
   * `cachedTargetCapabilityId` for the grace path to reuse the cached value;
   * a mismatch (e.g. device re-paired and the target capability changed)
   * invalidates the cache and the call falls through to the skip path.
   */
  capabilityId: string | undefined;
  payload: Record<string, unknown>;
  debugStructured?: StructuredDebugEmitter;
  logger: PinoLogger;
}): ResolvedModeTargetSeed {
  const { state, deviceId, capabilityValue, capabilityId, payload, debugStructured, logger } = params;
  const capabilityValueFresh = typeof capabilityValue === 'number' && Number.isFinite(capabilityValue);
  const nowMs = Date.now();
  if (capabilityValueFresh) {
    emitMissingModeTargetThrottled({
      state, deviceId, event: 'missing_mode_target', payload, nowMs, debugStructured, logger,
    });
    return { kind: 'fallback', value: capabilityValue };
  }
  const grace = applyMissingModeTargetGrace(state, deviceId, capabilityId);
  if (grace.kind === 'grace_fallback') return grace;
  // NOTE: `payload.operatingMode` reflects the operating mode at *this* emit
  // moment, not at the first miss. Mode transitions during the missing window
  // do not reset the throttle — the same `missing_mode_target_and_current_target`
  // event continues to throttle for 15 min. Readers correlating heartbeat
  // re-emits with mode-switch traces should be aware that intermediate
  // transitions are invisible at this surface.
  emitMissingModeTargetThrottled({
    state, deviceId, event: 'missing_mode_target_and_current_target', payload, nowMs, debugStructured, logger,
  });
  return { kind: 'skip' };
}

type CachedTargetEvaluation =
  | { usable: true; value: number; capabilityId: string | undefined }
  | { usable: false; invalidatedByCapabilityChange: boolean };

/**
 * Resolve whether the cached capability value can ride out a missing-mode
 * cycle. Caller uses `invalidatedByCapabilityChange` (only meaningful when
 * `usable === false`) to decide whether to drop the cache before persisting
 * the next state.
 */
function evaluateCachedTarget(
  tracking: PlanEngineState['modeTargetMissingByDevice'][string] | undefined,
  currentCapabilityId: string | undefined,
): CachedTargetEvaluation {
  const cachedValue = tracking?.cachedTargetValue;
  const cachedCapabilityId = tracking?.cachedTargetCapabilityId;
  const cachedValueFresh = typeof cachedValue === 'number' && Number.isFinite(cachedValue);
  if (!cachedValueFresh) {
    return { usable: false, invalidatedByCapabilityChange: false };
  }
  const cachedCapabilityMatches = cachedCapabilityId === undefined
    || currentCapabilityId === undefined
    || cachedCapabilityId === currentCapabilityId;
  if (!cachedCapabilityMatches) {
    return { usable: false, invalidatedByCapabilityChange: true };
  }
  return { usable: true, value: cachedValue, capabilityId: cachedCapabilityId };
}

/**
 * Increment the per-device missed-cycle counter and decide whether the grace
 * window still applies. When grace is exhausted, no cached value exists, or
 * the cached capability ID does not match the current primary capability ID
 * (e.g. a re-pair swapped capabilities during the grace window), the caller
 * falls through to its existing skip path. Caps `missingCycles` at
 * `MODE_TARGET_GRACE_CYCLES + 1` once the grace window is exhausted so the
 * counter does not grow unbounded while a device stays in skip — purely
 * cosmetic for log / snapshot stability.
 */
function applyMissingModeTargetGrace(
  state: PlanEngineState,
  deviceId: string,
  currentCapabilityId: string | undefined,
): GraceEvaluation {
  const tracking = state.modeTargetMissingByDevice[deviceId];
  const cache = evaluateCachedTarget(tracking, currentCapabilityId);
  const capCycles = MODE_TARGET_GRACE_CYCLES + 1;
  const nextMissingCycles = Math.min((tracking?.missingCycles ?? 0) + 1, capCycles);
  if (cache.usable && nextMissingCycles <= MODE_TARGET_GRACE_CYCLES) {
    // eslint-disable-next-line no-param-reassign -- shared plan engine state update
    state.modeTargetMissingByDevice[deviceId] = {
      ...(tracking ?? {}),
      missingCycles: nextMissingCycles,
      cachedTargetValue: cache.value,
      ...(cache.capabilityId !== undefined
        ? { cachedTargetCapabilityId: cache.capabilityId }
        : {}),
    };
    return { kind: 'grace_fallback', value: cache.value };
  }
  // Capability mismatch (re-pair during grace) invalidates the cache: drop
  // it so a future fresh read for the new capability rebuilds it from scratch
  // and the grace counter behaves as if no cache had ever existed.
  const nextEntry: PlanEngineState['modeTargetMissingByDevice'][string] = {
    ...(tracking ?? {}),
    missingCycles: nextMissingCycles,
  };
  if (!cache.usable && cache.invalidatedByCapabilityChange) {
    delete nextEntry.cachedTargetValue;
    delete nextEntry.cachedTargetCapabilityId;
  }
  // eslint-disable-next-line no-param-reassign -- shared plan engine state update
  state.modeTargetMissingByDevice[deviceId] = nextEntry;
  return { kind: 'skip' };
}

/**
 * Per-device emit gating for `missing_mode_target` /
 * `missing_mode_target_and_current_target`. Emit on (a) first occurrence, (b)
 * event-kind change (fallback → skip or vice versa), or (c) heartbeat
 * interval elapsed. Same pattern as
 * `lib/app/appSnapshotHelpers.ts:STALE_OBSERVATION_REFRESH_LOG_BACKOFF_MS`.
 * Returns true when an emit was actually fired (the caller doesn't need it,
 * but it's useful for tests and future caller introspection).
 */
function emitMissingModeTargetThrottled(params: {
  state: PlanEngineState;
  deviceId: string;
  event: MissingModeTargetEvent;
  payload: Record<string, unknown>;
  nowMs: number;
  debugStructured?: StructuredDebugEmitter;
  logger: PinoLogger;
}): boolean {
  const { state, deviceId, event, payload, nowMs, debugStructured, logger } = params;
  const tracking = state.modeTargetMissingByDevice[deviceId];
  const lastEmitMs = tracking?.lastEmitAtMs;
  const lastEmitEvent = tracking?.lastEmitEvent;
  const shouldEmit = lastEmitMs === undefined
    || lastEmitEvent !== event
    || (nowMs - lastEmitMs) >= MISSING_MODE_TARGET_EMIT_INTERVAL_MS;
  if (!shouldEmit) return false;
  state.modeTargetMissingByDevice[deviceId] = {
    ...(tracking ?? { missingCycles: 0 }),
    lastEmitAtMs: nowMs,
    lastEmitEvent: event,
  };
  if (debugStructured) {
    debugStructured({ event, ...payload });
  } else {
    logger.debug({ event, ...payload });
  }
  return true;
}

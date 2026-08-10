import type {
  TargetPowerReachabilityState,
  TargetPowerSteppedLoadConfig,
  TargetPowerSteppedLoadPreset,
} from '../../packages/contracts/src/types';
import { assessTargetPowerLadderOptions } from '../../packages/shared-domain/src/targetPowerLadder';

type UnknownRecord = Record<string, unknown>;

/**
 * The boundary that decides whether a persisted or device-supplied target-power
 * config is stepped control at all.
 *
 * A config only survives here when it yields a usable ladder, so every consumer
 * downstream may take "I have a config" to mean "I have a ladder". A range that
 * cannot produce one — `{ max: 100, step: 500 }`, say — is dropped outright
 * rather than kept as a config whose ladder resolves to nothing later; keeping
 * it is what let a device be classified as stepped with nowhere to stand.
 */
export function normalizeTargetPowerSteppedLoadConfig(
  value: unknown,
): TargetPowerSteppedLoadConfig | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed) return undefined;
  const config = buildTargetPowerSteppedLoadConfig(parsed);
  if (Object.keys(config).length === 0) return undefined;
  return isAcceptableTargetPowerSteppedLoadConfig(config) ? config : undefined;
}

function buildTargetPowerSteppedLoadConfig(parsed: UnknownRecord): TargetPowerSteppedLoadConfig {
  const preset = normalizePreset(parsed.preset);
  const min = normalizeFiniteNumber(parsed.min);
  const max = normalizeFiniteNumber(parsed.max);
  const step = normalizeFiniteNumber(parsed.step);
  const excludeMin = normalizeFiniteNumber(parsed.excludeMin);
  const excludeMax = normalizeFiniteNumber(parsed.excludeMax);
  const enabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined;
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(preset ? { preset } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(excludeMin !== undefined ? { excludeMin } : {}),
    ...(excludeMax !== undefined ? { excludeMax } : {}),
  };
}

function normalizeTargetPowerReachability(value: unknown): TargetPowerReachabilityState | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed || typeof parsed.profileFingerprint !== 'string' || !parsed.profileFingerprint) return undefined;
  const maxReachedPowerW = normalizeFiniteNumber(parsed.maxReachedPowerW);
  const probeFailureCount = normalizeFiniteNumber(parsed.probeFailureCount);
  const nextProbeAtMs = normalizeFiniteNumber(parsed.nextProbeAtMs);
  if (
    maxReachedPowerW === undefined
    || maxReachedPowerW < 0
    || probeFailureCount === undefined
    || !Number.isInteger(probeFailureCount)
    || probeFailureCount < 0
    || (parsed.nextProbeAtMs !== undefined && nextProbeAtMs === undefined)
    || (nextProbeAtMs !== undefined && nextProbeAtMs < 0)
  ) return undefined;
  return {
    profileFingerprint: parsed.profileFingerprint,
    maxReachedPowerW,
    probeFailureCount,
    ...(nextProbeAtMs !== undefined ? { nextProbeAtMs } : {}),
  };
}

export function normalizeTargetPowerReachabilityByDevice(
  value: unknown,
): Record<string, TargetPowerReachabilityState> {
  const record = parseJsonObject(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).flatMap(([deviceId, entry]) => {
    const normalizedId = deviceId.trim();
    const reachability = normalizeTargetPowerReachability(entry);
    return normalizedId && reachability ? [[normalizedId, reachability]] : [];
  }));
}

/** Resolve the runtime-owned map only when every persisted sibling is valid. */
export function normalizeCompleteTargetPowerReachabilityByDevice(
  value: unknown,
): Record<string, TargetPowerReachabilityState> | undefined {
  const record = parseJsonObject(value);
  if (!record) return undefined;
  const normalized = normalizeTargetPowerReachabilityByDevice(record);
  const complete = Object.keys(record).every((deviceId) => (
    deviceId.length > 0
    && deviceId.trim() === deviceId
    && Object.hasOwn(normalized, deviceId)
  ));
  return complete ? normalized : undefined;
}

function isAcceptableTargetPowerSteppedLoadConfig(config: TargetPowerSteppedLoadConfig): boolean {
  // An explicit off is a record of the user's choice, not stepped control; it
  // carries no range to validate and never reaches the ladder builder.
  if (config.enabled === false) return true;
  // A preset owns its own rungs (`buildEvTargetPowerCandidateProfile`), which
  // always include an amp step above zero, and falls back to the nominal 32 A
  // ceiling when `max` is absent or junk.
  if (config.preset) return true;
  // Everything else is a range, and a range only counts when it yields a
  // ladder. This is the same assessment the producer and the settings UI run,
  // so the three cannot drift apart.
  return assessTargetPowerLadderOptions(config).valid;
}

export function normalizeDeviceTargetPowerConfigs(
  value: unknown,
): Record<string, TargetPowerSteppedLoadConfig> {
  const record = parseJsonObject(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).flatMap(([deviceId, entry]) => {
      const normalizedId = deviceId.trim();
      const config = normalizeTargetPowerSteppedLoadConfig(entry);
      return normalizedId && config ? [[normalizedId, config]] : [];
    }),
  );
}

function parseJsonObject(value: unknown): UnknownRecord | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as UnknownRecord;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as UnknownRecord
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizePreset(value: unknown): TargetPowerSteppedLoadPreset | undefined {
  return value === 'ev_charger_1_phase' || value === 'ev_charger_3_phase'
    ? value
    : undefined;
}

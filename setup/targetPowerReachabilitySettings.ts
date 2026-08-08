import type Homey from 'homey';
import type {
  TargetPowerReachabilityState,
  TargetPowerSteppedLoadConfig,
} from '../packages/contracts/src/types';
import { normalizeCompleteTargetPowerReachabilityByDevice } from '../lib/utils/targetPowerConfig';
import {
  isEvTargetPowerConfig,
  resolveValidTargetPowerReachability,
} from '../lib/device/targetPowerReachability';
import { DEVICE_TARGET_POWER_REACHABILITY } from '../lib/utils/settingsKeys';
import type { AppContext } from '../lib/app/appContext';

type FreshConfigsRead =
  | { state: 'resolved'; reachabilityByDevice: Record<string, TargetPowerReachabilityState> }
  | { state: 'unavailable' };

export type TargetPowerReachabilityPersistenceResult = 'persisted' | 'unchanged' | 'unavailable';

export type TargetPowerReachabilityApplyResult = {
  applied: boolean;
  persistence: TargetPowerReachabilityPersistenceResult | 'invalid';
};

const readFreshConfigs = (
  settings: Homey.App['homey']['settings'],
): FreshConfigsRead => {
  try {
    const raw = settings.get(DEVICE_TARGET_POWER_REACHABILITY) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const normalized = normalizeCompleteTargetPowerReachabilityByDevice(raw);
      return normalized
        ? { state: 'resolved', reachabilityByDevice: normalized }
        : { state: 'unavailable' };
    }
    if (typeof raw !== 'string') {
      if (raw !== undefined && raw !== null) return { state: 'unavailable' };
      const keys = settings.getKeys() as unknown;
      return Array.isArray(keys)
        && keys.length > 0
        && keys.every((key): key is string => typeof key === 'string')
        && !keys.includes(DEVICE_TARGET_POWER_REACHABILITY)
        ? { state: 'resolved', reachabilityByDevice: {} }
        : { state: 'unavailable' };
    }
    const normalized = normalizeCompleteTargetPowerReachabilityByDevice(raw);
    return normalized
      ? { state: 'resolved', reachabilityByDevice: normalized }
      : { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
};

/**
 * Runtime-owned write lane for EV reachability state. Keeping this map separate
 * from the user-authored candidate configs makes UI edits and background probe
 * feedback unable to overwrite one another.
 */
export const writeTargetPowerReachabilitySetting = (params: {
  settings: Homey.App['homey']['settings'];
  config: TargetPowerSteppedLoadConfig;
  deviceId: string;
  reachability: TargetPowerReachabilityState;
}): TargetPowerReachabilityPersistenceResult => {
  const fresh = readFreshConfigs(params.settings);
  if (fresh.state === 'unavailable') return 'unavailable';
  const currentMap = fresh.reachabilityByDevice;
  const config = params.config;
  if (!isEvTargetPowerConfig(config)) return 'unavailable';
  if (!resolveValidTargetPowerReachability({ ...config, reachability: params.reachability })) {
    return 'unavailable';
  }
  const currentReachability = currentMap[params.deviceId];
  if (
    currentReachability?.profileFingerprint === params.reachability.profileFingerprint
    && currentReachability.maxReachedPowerW === params.reachability.maxReachedPowerW
    && currentReachability.probeFailureCount === params.reachability.probeFailureCount
    && currentReachability.nextProbeAtMs === params.reachability.nextProbeAtMs
  ) return 'unchanged';
  const next = {
    ...currentMap,
    [params.deviceId]: params.reachability,
  };
  params.settings.set(DEVICE_TARGET_POWER_REACHABILITY, next);
  return 'persisted';
};

export const writeTargetPowerReachabilityForApp = (
  ctx: AppContext,
  deviceId: string,
  reachability: TargetPowerReachabilityState,
): TargetPowerReachabilityApplyResult => {
  const config = ctx.deviceTargetPowerConfigs[deviceId];
  if (!config) return { applied: false, persistence: 'invalid' };
  const resolved = resolveValidTargetPowerReachability({ ...config, reachability });
  if (!resolved) return { applied: false, persistence: 'invalid' };
  const current = resolveValidTargetPowerReachability(config);
  const applied = !current
    || current.profileFingerprint !== resolved.profileFingerprint
    || current.maxReachedPowerW !== resolved.maxReachedPowerW
    || current.probeFailureCount !== resolved.probeFailureCount
    || current.nextProbeAtMs !== resolved.nextProbeAtMs;
  if (applied) {
    // Operational convergence is independent of Homey settings availability.
    // eslint-disable-next-line functional/immutable-data, no-param-reassign
    ctx.deviceTargetPowerConfigs = {
      ...ctx.deviceTargetPowerConfigs,
      [deviceId]: { ...config, reachability: resolved },
    };
  }
  try {
    const persistence = writeTargetPowerReachabilitySetting({
      settings: ctx.homey.settings,
      config,
      deviceId,
      reachability: resolved,
    });
    return { applied, persistence };
  } catch (error) {
    ctx.getStructuredLogger('devices')?.error({
      event: 'target_power_reachability_write_failed',
      deviceId,
      err: error,
    });
    return { applied, persistence: 'unavailable' };
  }
};

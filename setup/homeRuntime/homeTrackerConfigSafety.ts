import type Homey from 'homey';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import {
  HOMES_CONFIG,
} from '../../lib/utils/settingsKeys';
import {
  HOME_CONFIG_ACTIVATION_VERSION,
  HomeStoreWriteRefusedError,
  type HomeConfig,
  type HomesStore,
  type SubHomeConfig,
} from '../../lib/home/homeConfig';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { SettingsUiHomesSaveRequest } from '../../packages/contracts/src/settingsUiHomes';
import {
  beginPersistedHomeTrackerFreshnessResetInSettings,
} from '../../lib/power/persistedHomeTracker';

type AreaMutationRequest = Exclude<
SettingsUiHomesSaveRequest,
{ op: 'set_main_meter' } | { op: 'set_power_source' }
>;

type HomeTrackerConfigSafetyFailure =
  | {
    phase: 'tracker_read' | 'tracker_reset' | 'tracker_restore';
    homeId: string;
    settingKey: string;
    error: Error;
  }
  | {
    phase: 'config_write' | 'config_compensation';
    settingKey: typeof HOMES_CONFIG;
    error: Error;
  };

type ReportHomeTrackerConfigSafetyFailure = (
  failure: HomeTrackerConfigSafetyFailure,
) => void;

type ApiLoggerProvider = {
  getApiStructuredLogger(): PinoLogger | undefined;
};

/** Shape-guarded access to the app's structured API logger; `null` when unwired. */
export const resolveApiLoggerProvider = (value: unknown): ApiLoggerProvider | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ApiLoggerProvider>;
  return typeof candidate.getApiStructuredLogger === 'function'
    ? candidate as ApiLoggerProvider
    : null;
};

const reportToConsole = (...args: unknown[]): void => {
  try {
    console.error(...args);
  } catch {
    // Logging is diagnostic only; it must never alter persistence safety.
  }
};

const reportHomeTrackerConfigSafetyFailure = (params: {
  apiApp: unknown;
  requestOp: AreaMutationRequest['op'];
  failure: HomeTrackerConfigSafetyFailure;
}): void => {
  const { apiApp, requestOp, failure } = params;
  const fields = {
    event: 'home_tracker_config_commit_failed',
    requestOp,
    phase: failure.phase,
    settingKey: failure.settingKey,
    ...('homeId' in failure ? { homeId: failure.homeId } : {}),
    err: failure.error,
  };
  try {
    const logger = resolveApiLoggerProvider(apiApp)?.getApiStructuredLogger();
    if (logger) {
      logger.error(fields);
      return;
    }
  } catch (loggingError) {
    reportToConsole('settings UI homes config logger failed', fields, loggingError);
    return;
  }
  reportToConsole('settings UI homes config commit failed', fields);
};

/** Compose the one homes-config value written for an owner-authored intent op. */
export const buildHomesConfigWrite = (
  request: AreaMutationRequest,
  currentConfig: HomeConfig,
  subHomes: SubHomeConfig[],
): HomeConfig => {
  const active = request.op === 'upsert'
    || currentConfig.activationVersion === HOME_CONFIG_ACTIVATION_VERSION;
  return {
    ...(active ? { activationVersion: HOME_CONFIG_ACTIVATION_VERSION } : {}),
    subHomes,
  };
};

type HomesConfigWriteResult =
  | { state: 'committed' }
  | { state: 'invalid' }
  | { state: 'unchanged_after_failure' }
  | { state: 'unavailable' };

/**
 * Persist one composed area mutation and classify every store failure here.
 * A generic thrown write has uncertain commit semantics, so the resolved
 * semantic prior (present config or unwritten-as-empty) is written back as
 * compensation. Only that successful write proves the prior durable enough
 * to authorize tracker rollback.
 */
const persistHomesConfigWrite = (params: {
  store: HomesStore;
  request: AreaMutationRequest;
  currentConfig: HomeConfig;
  next: SubHomeConfig[];
  onFailure: ReportHomeTrackerConfigSafetyFailure;
}): HomesConfigWriteResult => {
  const intended = buildHomesConfigWrite(params.request, params.currentConfig, params.next);
  try {
    params.store.write(intended);
    return { state: 'committed' };
  } catch (error) {
    if (error instanceof HomeStoreWriteRefusedError) return { state: 'invalid' };
    params.onFailure({
      phase: 'config_write',
      settingKey: HOMES_CONFIG,
      error: normalizeError(error),
    });
    try {
      // `currentConfig` is also the resolved semantic prior for an unwritten
      // store (`{ subHomes: [] }`). Persisting it repairs a marker-first
      // partial first write and keeps the next save retryable.
      params.store.write(params.currentConfig);
      return { state: 'unchanged_after_failure' };
    } catch (compensationError) {
      params.onFailure({
        phase: 'config_compensation',
        settingKey: HOMES_CONFIG,
        error: normalizeError(compensationError),
      });
      return { state: 'unavailable' };
    }
  }
};

const resolveFreshnessResetHomeIds = (
  request: AreaMutationRequest,
  currentConfig: HomeConfig,
  next: readonly SubHomeConfig[],
): string[] => {
  const activationHomeIds = (
    request.op === 'upsert'
    && currentConfig.activationVersion !== HOME_CONFIG_ACTIVATION_VERSION
  )
    // This one write activates every EXISTING configured area, not only the
    // edited one. A newly allocated area has no prior runtime freshness to
    // reset, and a genuinely empty settings store must remain a valid create.
    ? currentConfig.subHomes.map((home) => home.homeId)
    : [];
  if (request.op === 'delete') {
    return currentConfig.subHomes.some((home) => home.homeId === request.homeId)
      ? [request.homeId]
      : [];
  }
  if (request.area.homeId === undefined) return activationHomeIds;
  const current = currentConfig.subHomes.find((home) => home.homeId === request.area.homeId);
  const updated = next.find((home) => home.homeId === request.area.homeId);
  const upsertHomeIds = updated && (
    current === undefined || current.meterDeviceId !== updated.meterDeviceId
  )
    ? [request.area.homeId]
    : [];
  return [...new Set([...activationHomeIds, ...upsertHomeIds])];
};

/**
 * Clear every freshness latch whose meter/runtime identity changes before the
 * corresponding whole-value homes config is committed. The returned rollback
 * restores all prior typed tracker states when the config adapter proves the
 * old config remained durable.
 */
type HomeTrackerFreshnessResetTransaction =
  | { state: 'prepared'; rollback: () => boolean }
  | { state: 'unavailable' };

const runTrackerRollbacks = (
  rollbacks: ReadonlyArray<() => boolean>,
): boolean => {
  let complete = true;
  for (const rollback of rollbacks) {
    if (!rollback()) complete = false;
  }
  return complete;
};

const beginHomeTrackerFreshnessResetBeforeConfigWrite = (params: {
  settings: Homey.App['homey']['settings'];
  request: AreaMutationRequest;
  currentConfig: HomeConfig;
  next: readonly SubHomeConfig[];
  onFailure: ReportHomeTrackerConfigSafetyFailure;
}): HomeTrackerFreshnessResetTransaction => {
  const {
    settings, request, currentConfig, next, onFailure,
  } = params;
  const homeIds = resolveFreshnessResetHomeIds(request, currentConfig, next);
  let rollbacks: ReadonlyArray<() => boolean> = [];
  for (const homeId of homeIds) {
    const reset = beginPersistedHomeTrackerFreshnessResetInSettings({
      settings,
      homeId,
      onFailure: (failure) => onFailure({ ...failure, homeId }),
    });
    if (reset.state === 'unavailable') {
      runTrackerRollbacks(rollbacks);
      return { state: 'unavailable' };
    }
    rollbacks = [reset.rollback, ...rollbacks];
  }
  return {
    state: 'prepared',
    rollback: () => runTrackerRollbacks(rollbacks),
  };
};

/**
 * Commit one homes-config intent with its identity-bound tracker resets.
 * Known non-commits restore every prior tracker; uncertain writes retain the
 * fail-closed reset and surface only semantic `unavailable`.
 */
export const commitHomesConfigWriteWithTrackerFreshnessReset = (params: {
  apiApp: unknown;
  settings: Homey.App['homey']['settings'];
  store: HomesStore;
  request: AreaMutationRequest;
  currentConfig: HomeConfig;
  next: SubHomeConfig[];
}): { state: 'committed' | 'invalid' | 'unavailable' } => {
  const onFailure: ReportHomeTrackerConfigSafetyFailure = (failure) => {
    reportHomeTrackerConfigSafetyFailure({
      apiApp: params.apiApp,
      requestOp: params.request.op,
      failure,
    });
  };
  const trackerReset = beginHomeTrackerFreshnessResetBeforeConfigWrite({
    ...params,
    onFailure,
  });
  if (trackerReset.state === 'unavailable') return { state: 'unavailable' };
  const write = persistHomesConfigWrite({ ...params, onFailure });
  if (write.state === 'committed') return write;
  // Failed compensation cannot prove which config owns the tracker, so retain
  // the safe freshness reset. Roll back only after a proven non-commit.
  if (write.state === 'unavailable') return write;
  const restored = trackerReset.rollback();
  if (!restored || write.state === 'unchanged_after_failure') {
    return { state: 'unavailable' };
  }
  return { state: 'invalid' };
};

import { getLogger, type Logger as PinoLogger } from '../../lib/logging/logger';
import {
  HOMES_CONFIG,
} from '../../lib/utils/settingsKeys';
import {
  HomeStoreWriteRefusedError,
  type HomeConfig,
  type HomesStore,
  type SubHomeConfig,
} from '../../lib/home/homeConfig';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { SettingsUiHomesSaveRequest } from '../../packages/contracts/src/settingsUiHomes';
import {
  beginTrackerFreshnessReset,
  type TrackerFreshnessFailure,
  type TrackerFreshnessReset,
} from '../../lib/power/trackerMeterIdentity';
import type { TrackerStore } from '../../lib/power/trackerStore';

type AreaMutationRequest = Exclude<
SettingsUiHomesSaveRequest,
{ op: 'set_main_meter' } | { op: 'set_power_source' }
>;

type HomeTrackerConfigSafetyFailure =
  | TrackerFreshnessFailure
  | {
    phase: 'config_write' | 'config_compensation';
    settingKey: typeof HOMES_CONFIG;
    error: Error;
  };

type ReportHomeTrackerConfigSafetyFailure = (
  failure: HomeTrackerConfigSafetyFailure,
) => void;

type ApiLoggerProvider = {
  getApiStructuredLogger(): PinoLogger;
};

/** Shape-guarded access to the app's structured API logger; `null` when unwired. */
export const resolveApiLoggerProvider = (value: unknown): ApiLoggerProvider | null => {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ApiLoggerProvider>;
  return typeof candidate.getApiStructuredLogger === 'function'
    ? candidate as ApiLoggerProvider
    : null;
};

// Used when the API logger is unwired or itself throws: the module logger is
// late-bound to the root and always exists.
const fallbackLogger = getLogger('settings-ui/homes-config');

/** What a failure names: the config key for a config phase, the home for a tracker phase. */
const failureScope = (failure: HomeTrackerConfigSafetyFailure): { settingKey: string } | { homeId: string } => {
  switch (failure.phase) {
    case 'config_write':
    case 'config_compensation':
      return { settingKey: failure.settingKey };
    default:
      return { homeId: failure.homeId };
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
    ...failureScope(failure),
    err: failure.error,
  };
  try {
    const logger = resolveApiLoggerProvider(apiApp)?.getApiStructuredLogger();
    if (logger) {
      logger.error(fields);
      return;
    }
  } catch (loggingError) {
    fallbackLogger.error({ ...fields, loggerErrorMessage: normalizeError(loggingError).message });
    return;
  }
  fallbackLogger.error(fields);
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
  currentConfig: HomeConfig;
  next: SubHomeConfig[];
  onFailure: ReportHomeTrackerConfigSafetyFailure;
}): HomesConfigWriteResult => {
  try {
    params.store.write({ subHomes: params.next });
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

// The one area whose meter or runtime identity the mutation changes: the
// deleted area, or an upserted area that is new or reads another meter.
const resolveFreshnessResetHomeId = (
  request: AreaMutationRequest,
  currentConfig: HomeConfig,
  next: readonly SubHomeConfig[],
): string | null => {
  if (request.op === 'delete') {
    return currentConfig.subHomes.some((home) => home.homeId === request.homeId) ? request.homeId : null;
  }
  if (request.area.homeId === undefined) return null;
  const current = currentConfig.subHomes.find((home) => home.homeId === request.area.homeId);
  const updated = next.find((home) => home.homeId === request.area.homeId);
  return updated && (current === undefined || current.meterDeviceId !== updated.meterDeviceId)
    ? request.area.homeId
    : null;
};

/**
 * Clear the freshness latch whose meter/runtime identity changes before the
 * whole-value homes config is committed. The returned rollback restores the
 * prior typed tracker state when the config adapter proves the old config
 * remained durable.
 */
const beginHomeTrackerFreshnessResetBeforeConfigWrite = (params: {
  trackerStore: TrackerStore;
  request: AreaMutationRequest;
  currentConfig: HomeConfig;
  next: readonly SubHomeConfig[];
  onFailure: ReportHomeTrackerConfigSafetyFailure;
}): TrackerFreshnessReset => {
  const homeId = resolveFreshnessResetHomeId(params.request, params.currentConfig, params.next);
  if (homeId === null) return { state: 'prepared', rollback: () => true };
  return beginTrackerFreshnessReset(params.trackerStore, homeId, undefined, params.onFailure);
};

/**
 * Commit one homes-config intent with its identity-bound tracker reset.
 * A known non-commit restores the prior tracker; an uncertain write retains
 * the fail-closed reset and surfaces only semantic `unavailable`.
 */
export const commitHomesConfigWriteWithTrackerFreshnessReset = (params: {
  apiApp: unknown;
  trackerStore: TrackerStore;
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

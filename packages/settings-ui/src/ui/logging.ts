import type { SettingsUiLogEntry, SettingsUiLogLevel } from '../../../contracts/src/types';
import { SETTINGS_UI_LOG_PATH } from '../../../contracts/src/settingsUiApi';
import { callApi } from './homey';

const pendingLogs: SettingsUiLogEntry[] = [];

export type SettingsUiNetworkFailureMeta = {
  component: string;
  event: string;
  endpoint: string;
  refreshLoop: string;
  message: string;
};

type SettingsUiNetworkLogEntry = SettingsUiLogEntry & SettingsUiNetworkFailureMeta & {
  errorType: string;
  consecutiveFailureCount: number;
  timeSinceLastSuccessMs: number | null;
};

type NetworkFailureState = {
  consecutiveFailureCount: number;
  lastSuccessAtMs: number | null;
};

const networkFailureStates = new Map<string, NetworkFailureState>();
const SETTINGS_UI_NETWORK_FAILURE_TAG = '__settingsUiNetworkFailureLogged__';

const normalizeErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const classifyErrorType = (error: unknown): string => {
  if (error instanceof Error && error.name) return error.name;
  if (error === null) return 'null';
  if (typeof error === 'string') return 'string';
  return typeof error;
};

const buildNetworkFailureKey = (meta: SettingsUiNetworkFailureMeta) => (
  [meta.component, meta.event, meta.endpoint, meta.refreshLoop].join('|')
);

const getNetworkFailureState = (meta: SettingsUiNetworkFailureMeta): NetworkFailureState => {
  const key = buildNetworkFailureKey(meta);
  const current = networkFailureStates.get(key);
  if (current) return current;
  const initialState: NetworkFailureState = {
    consecutiveFailureCount: 0,
    lastSuccessAtMs: null,
  };
  networkFailureStates.set(key, initialState);
  return initialState;
};

const markNetworkFailureError = <T extends Error>(error: T): T => {
  const taggedError = error as T & { [SETTINGS_UI_NETWORK_FAILURE_TAG]?: true };
  taggedError[SETTINGS_UI_NETWORK_FAILURE_TAG] = true;
  return taggedError as T;
};

export const isSettingsUiNetworkFailureLogged = (error: unknown): boolean => (
  Boolean(
    error
    && typeof error === 'object'
    && (error as Record<string, unknown>)[SETTINGS_UI_NETWORK_FAILURE_TAG] === true,
  )
);

const buildLogEntry = (
  level: SettingsUiLogLevel,
  message: string,
  detail?: string,
  context?: string,
): SettingsUiLogEntry => ({
  level,
  message,
  detail,
  context,
  timestamp: Date.now(),
});

const buildNetworkFailureEntry = (
  error: unknown,
  meta: SettingsUiNetworkFailureMeta,
): SettingsUiNetworkLogEntry => {
  const state = getNetworkFailureState(meta);
  state.consecutiveFailureCount += 1;
  const now = Date.now();
  return {
    ...buildLogEntry('error', meta.message, normalizeErrorMessage(error), meta.refreshLoop),
    ...meta,
    errorType: classifyErrorType(error),
    consecutiveFailureCount: state.consecutiveFailureCount,
    timeSinceLastSuccessMs: state.lastSuccessAtMs === null ? null : now - state.lastSuccessAtMs,
  };
};

const sendLog = async (entry: SettingsUiLogEntry): Promise<void> => {
  await callApi('POST', SETTINGS_UI_LOG_PATH, entry);
};

const queueLog = (entry: SettingsUiLogEntry) => {
  pendingLogs.push(entry);
};

const sendNetworkLog = async (entry: SettingsUiNetworkLogEntry): Promise<void> => {
  await sendLog(entry);
};

const queueNetworkLog = (entry: SettingsUiNetworkLogEntry) => {
  queueLog(entry);
};

export const markSettingsUiNetworkSuccess = (meta: SettingsUiNetworkFailureMeta): void => {
  const state = getNetworkFailureState(meta);
  state.consecutiveFailureCount = 0;
  state.lastSuccessAtMs = Date.now();
};

export const logSettingsNetworkError = async (
  error: unknown,
  meta: SettingsUiNetworkFailureMeta,
): Promise<void> => {
  const entry = buildNetworkFailureEntry(error, meta);
  try {
    await sendNetworkLog(entry);
  } catch {
    queueNetworkLog(entry);
  }
};

export const withSettingsUiNetworkFailureTracking = async <T>(
  meta: SettingsUiNetworkFailureMeta,
  operation: () => Promise<T>,
): Promise<T> => {
  try {
    const result = await operation();
    markSettingsUiNetworkSuccess(meta);
    return result;
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(normalizeErrorMessage(error));
    await logSettingsNetworkError(normalizedError, meta);
    throw markNetworkFailureError(normalizedError);
  }
};

export const logSettingsMessage = async (
  level: SettingsUiLogLevel,
  message: string,
  error?: unknown,
  context?: string,
): Promise<void> => {
  const detail = error === undefined ? undefined : normalizeErrorMessage(error);
  const entry = buildLogEntry(level, message, detail, context);
  try {
    await sendLog(entry);
  } catch {
    queueLog(entry);
  }
};

export const logSettingsInfo = (message: string, context?: string): Promise<void> => (
  logSettingsMessage('info', message, undefined, context)
);

export const logSettingsWarn = (message: string, error?: unknown, context?: string): Promise<void> => (
  logSettingsMessage('warn', message, error, context)
);

export const logSettingsError = (message: string, error: unknown, context?: string): Promise<void> => (
  logSettingsMessage('error', message, error, context)
);

export const flushSettingsLogs = async (): Promise<void> => {
  if (pendingLogs.length === 0) return;
  const queued = pendingLogs.splice(0, pendingLogs.length);
  for (const entry of queued) {
    try {
      await sendLog(entry);
    } catch {
      pendingLogs.unshift(entry);
      break;
    }
  }
};

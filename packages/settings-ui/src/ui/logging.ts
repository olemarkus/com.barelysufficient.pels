import type { SettingsUiLogEntry, SettingsUiLogLevel } from '../../../contracts/src/types.ts';
import { SETTINGS_UI_LOG_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { callApi } from './homey.ts';

const pendingLogs: SettingsUiLogEntry[] = [];
const NETWORK_FAILURE_WINDOW_MS = 5_000;
const NETWORK_FAILURE_TTL_MS = NETWORK_FAILURE_WINDOW_MS * 3;
const NETWORK_FAILURE_MAX_ENTRIES = 100;

type NetworkFailureState = {
  firstSeenAt: number;
  lastSeenAt: number;
  lastLoggedAt: number;
  suppressedCount: number;
};

const recentNetworkFailures = new Map<string, NetworkFailureState>();

const normalizeError = (error: unknown): string => {
  if (error instanceof Error) {
    const message = error.message || String(error);
    if (error.stack) {
      return error.stack.includes(message) ? error.stack : `${message}\n${error.stack}`;
    }
    return message;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const normalizeErrorSummary = (error: unknown): string => {
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

const isNetworkFailure = (message: string, detail?: string): boolean => {
  const text = `${message} ${detail || ''}`.toLowerCase();
  return text.includes('homey api')
    || text.includes('homey sdk not ready')
    || text.includes('cannot get /api/app/')
    || text.includes('cannot post /api/app/')
    || text.includes('cannot put /api/app/')
    || text.includes('cannot delete /api/app/');
};

const buildNetworkFailureKey = (message: string, error: unknown, context?: string): string => (
  [context || '', message, normalizeErrorSummary(error)].join('|')
);

const buildNetworkFailureDetail = (
  message: string,
  error: unknown,
  context?: string,
  state?: NetworkFailureState,
): string => JSON.stringify({
  event: 'settings_ui_network_failure',
  message,
  context,
  error: normalizeErrorSummary(error),
  firstSeenAt: state?.firstSeenAt ?? Date.now(),
  lastSeenAt: state?.lastSeenAt ?? Date.now(),
  suppressedCount: state?.suppressedCount ?? 0,
  windowMs: NETWORK_FAILURE_WINDOW_MS,
});

const pruneRecentNetworkFailures = (now: number) => {
  for (const [key, state] of recentNetworkFailures) {
    if (now - state.lastSeenAt > NETWORK_FAILURE_TTL_MS) {
      recentNetworkFailures.delete(key);
    }
  }
  if (recentNetworkFailures.size <= NETWORK_FAILURE_MAX_ENTRIES) return;

  const keysByAge = [...recentNetworkFailures.entries()]
    .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
    .map(([key]) => key);

  for (let index = 0; index < keysByAge.length - NETWORK_FAILURE_MAX_ENTRIES; index += 1) {
    recentNetworkFailures.delete(keysByAge[index]);
  }
};

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

const sendLog = async (entry: SettingsUiLogEntry): Promise<void> => {
  await callApi('POST', SETTINGS_UI_LOG_PATH, entry);
};

const queueLog = (entry: SettingsUiLogEntry) => {
  pendingLogs.push(entry);
};

export const logSettingsMessage = async (
  level: SettingsUiLogLevel,
  message: string,
  error?: unknown,
  context?: string,
): Promise<void> => {
  const detail = error === undefined ? undefined : normalizeError(error);
  if (error !== undefined && isNetworkFailure(message, detail)) {
    const key = buildNetworkFailureKey(message, error, context);
    const now = Date.now();
    pruneRecentNetworkFailures(now);
    const existing = recentNetworkFailures.get(key);
    if (existing && now - existing.lastLoggedAt < NETWORK_FAILURE_WINDOW_MS) {
      existing.lastSeenAt = now;
      existing.suppressedCount += 1;
      return;
    }
    const suppressedCount = existing?.suppressedCount ?? 0;
    const nextState: NetworkFailureState = existing
      ? {
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: now,
        lastLoggedAt: now,
        suppressedCount: 0,
      }
      : {
        firstSeenAt: now,
        lastSeenAt: now,
        lastLoggedAt: now,
        suppressedCount: 0,
      };
    recentNetworkFailures.set(key, nextState);
    const entry = buildLogEntry(
      level,
      'settings_ui_network_failure',
      buildNetworkFailureDetail(message, error, context, {
        ...nextState,
        suppressedCount,
      }),
      context,
    );
    try {
      await sendLog(entry);
    } catch {
      queueLog(entry);
    }
    pruneRecentNetworkFailures(now);
    return;
  }
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

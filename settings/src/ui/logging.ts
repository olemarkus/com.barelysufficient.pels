import type { SettingsUiLogEntry, SettingsUiLogLevel } from '../../../lib/utils/types';
import { setSetting } from './homey';

const pendingLogs: SettingsUiLogEntry[] = [];

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
  await setSetting('settings_ui_log', entry);
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

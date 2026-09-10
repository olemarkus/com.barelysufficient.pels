import { getLogger } from '../logging/logger';
import type { SettingsUiLogEntry } from '../../packages/contracts/src/types';
import type { SettingsHandlerDeps } from './settingsHandlers';

const settingsUiLogger = getLogger('settings');

/**
 * The settings UI's own log entries, drained into the runtime's structured log.
 *
 * A settings WRITE is the transport — the WebView cannot reach the logger, so it
 * posts an entry to the `settings_ui_log` key and this drains it — but it is not
 * a setting: nothing here reloads config, refreshes a snapshot or rebuilds a
 * plan, which is what every other handler in `settingsHandlers.ts` exists to do.
 * It lives beside that file rather than in it for that reason (and because the
 * file sits at its 500-line ceiling).
 *
 * The key is cleared after a successful drain so one entry is logged once.
 * Malformed or absent entries are dropped silently: this is an untrusted
 * boundary (the WebView bridge), and a junk write must not become a log storm.
 */
export const handleSettingsUiLog = async (deps: SettingsHandlerDeps): Promise<void> => {
  const raw = deps.homey.settings.get('settings_ui_log');
  if (!raw || typeof raw !== 'object') return;
  const entry = raw as SettingsUiLogEntry;
  if (!entry.level || !entry.message) return;

  const payload = {
    event: 'settings_ui_log',
    level: entry.level,
    message: entry.message,
    detail: entry.detail ?? null,
    context: entry.context ?? null,
  };
  // Spelled out rather than indexed by a computed level. The indexed form
  // (`logger[method](…)`) is banned because the call site cannot say which
  // method it resolves to, and one of the possibilities is a dark `.debug`.
  // These three are the whole of `SettingsUiLogLevel`, and none of them is it.
  if (entry.level === 'error') settingsUiLogger.error(payload);
  else if (entry.level === 'warn') settingsUiLogger.warn(payload);
  else settingsUiLogger.info(payload);

  deps.homey.settings.set('settings_ui_log', null);
};

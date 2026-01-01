import type Homey from 'homey';
import { ALL_DEBUG_LOGGING_TOPICS, type DebugLoggingTopic, normalizeDebugLoggingTopics } from '../utils/debugLogging';
import { DEBUG_LOGGING_TOPICS } from '../utils/settingsKeys';

export function buildDebugLoggingTopics(params: {
  settings: Homey.App['homey']['settings'];
  log: (...args: unknown[]) => void;
  logChange?: boolean;
}): Set<DebugLoggingTopic> {
  const { settings, log, logChange } = params;
  const rawTopics = settings.get(DEBUG_LOGGING_TOPICS) as unknown;
  let enabledTopics = normalizeDebugLoggingTopics(rawTopics);
  if (enabledTopics.length === 0) {
    const legacyEnabled = settings.get('debug_logging_enabled') as unknown;
    if (legacyEnabled === true) {
      enabledTopics = [...ALL_DEBUG_LOGGING_TOPICS];
    }
  }
  if (logChange) {
    const label = enabledTopics.length ? enabledTopics.join(', ') : 'disabled';
    log(`Debug logging topics: ${label}`);
  }
  return new Set(enabledTopics);
}

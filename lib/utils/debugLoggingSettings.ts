import type { SettingsPort } from '../ports/homeyRuntime';
import {
  ALL_DEBUG_LOGGING_TOPICS,
  type DebugLoggingTopic,
  normalizeDebugLoggingTopics,
} from '../../packages/shared-domain/src/utils/debugLogging';
import { DEBUG_LOGGING_TOPICS } from '../utils/settingsKeys';
import { getLogger } from '../logging/logger';

const settingsLogger = getLogger('settings/debug-logging');

export function buildDebugLoggingTopics(params: {
  settings: SettingsPort;
  logChange?: boolean;
}): Set<DebugLoggingTopic> {
  const { settings, logChange } = params;
  const rawTopics = settings.get(DEBUG_LOGGING_TOPICS) as unknown;
  let enabledTopics = normalizeDebugLoggingTopics(rawTopics);
  if (enabledTopics.length === 0) {
    const legacyEnabled = settings.get('debug_logging_enabled') as unknown;
    if (legacyEnabled === true) {
      enabledTopics = [...ALL_DEBUG_LOGGING_TOPICS];
    }
  }
  if (logChange) {
    settingsLogger.info({ event: 'debug_logging_topics_set', topics: enabledTopics });
  }
  return new Set(enabledTopics);
}

import { buildDebugLoggingTopics } from '../../lib/utils/debugLoggingSettings';
import { ALL_DEBUG_LOGGING_TOPICS } from '../../packages/shared-domain/src/utils/debugLogging';
import { DEBUG_LOGGING_TOPICS } from '../../lib/utils/settingsKeys';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';

// Mirrors `settingsWith` in weatherSettings.test.ts: a real `SettingsPort`, so a change to the
// port's shape breaks this stub instead of sliding past an `as any`.
const settingsWith = (get: (key: string) => unknown): SettingsPort => ({
  get,
  set: () => {},
  unset: () => {},
});

describe('buildDebugLoggingTopics', () => {
  let capture: LoggerCapture;

  beforeEach(() => {
    capture = captureLogger();
  });

  afterEach(() => {
    capture.restore();
  });

  it('uses explicit topics and logs when requested', () => {
    const settings = settingsWith((key) => (key === DEBUG_LOGGING_TOPICS ? ['plan', 'price'] : undefined));

    const result = buildDebugLoggingTopics({ settings, logChange: true });

    expect(Array.from(result).sort()).toEqual(['plan', 'price']);
    expect(capture.findEvent('debug_logging_topics_set')).toMatchObject({
      topics: ['plan', 'price'],
    });
  });

  it('falls back to legacy toggle when no topics are configured', () => {
    const settings = settingsWith((key) => (key === DEBUG_LOGGING_TOPICS ? [] : true));
    const result = buildDebugLoggingTopics({ settings });

    expect(result.size).toBe(ALL_DEBUG_LOGGING_TOPICS.length);
  });

  it('logs disabled when nothing is enabled', () => {
    const settings = settingsWith((key) => (key === DEBUG_LOGGING_TOPICS ? [] : false));

    const result = buildDebugLoggingTopics({ settings, logChange: true });

    expect(result.size).toBe(0);
    expect(capture.findEvent('debug_logging_topics_set')).toMatchObject({
      topics: [],
    });
  });
});

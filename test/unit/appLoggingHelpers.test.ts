import { buildDebugLoggingTopics } from '../../lib/utils/debugLoggingSettings';
import { ALL_DEBUG_LOGGING_TOPICS } from '../../packages/shared-domain/src/utils/debugLogging';
import { DEBUG_LOGGING_TOPICS } from '../../lib/utils/settingsKeys';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

describe('buildDebugLoggingTopics', () => {
  let capture: LoggerCapture;

  beforeEach(() => {
    capture = captureLogger();
  });

  afterEach(() => {
    capture.restore();
  });

  it('uses explicit topics and logs when requested', () => {
    const settings = {
      get: vi.fn((key: string) => (key === DEBUG_LOGGING_TOPICS ? ['plan', 'price'] : undefined)),
    } as any;

    const result = buildDebugLoggingTopics({ settings, logChange: true });

    expect(Array.from(result).sort()).toEqual(['plan', 'price']);
    expect(capture.findEvent('debug_logging_topics_set')).toMatchObject({
      topics: ['plan', 'price'],
    });
  });

  it('falls back to legacy toggle when no topics are configured', () => {
    const settings = {
      get: vi.fn((key: string) => (key === DEBUG_LOGGING_TOPICS ? [] : true)),
    } as any;
    const result = buildDebugLoggingTopics({ settings });

    expect(result.size).toBe(ALL_DEBUG_LOGGING_TOPICS.length);
  });

  it('logs disabled when nothing is enabled', () => {
    const settings = {
      get: vi.fn((key: string) => (key === DEBUG_LOGGING_TOPICS ? [] : false)),
    } as any;

    const result = buildDebugLoggingTopics({ settings, logChange: true });

    expect(result.size).toBe(0);
    expect(capture.findEvent('debug_logging_topics_set')).toMatchObject({
      topics: [],
    });
  });
});

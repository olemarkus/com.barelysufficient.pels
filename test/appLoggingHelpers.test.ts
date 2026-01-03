import { buildDebugLoggingTopics } from '../lib/app/appLoggingHelpers';
import { ALL_DEBUG_LOGGING_TOPICS } from '../lib/utils/debugLogging';
import { DEBUG_LOGGING_TOPICS } from '../lib/utils/settingsKeys';

describe('buildDebugLoggingTopics', () => {
  it('uses explicit topics and logs when requested', () => {
    const settings = {
      get: jest.fn((key: string) => (key === DEBUG_LOGGING_TOPICS ? ['plan', 'price'] : undefined)),
    } as any;
    const log = jest.fn();

    const result = buildDebugLoggingTopics({ settings, log, logChange: true });

    expect(Array.from(result).sort()).toEqual(['plan', 'price']);
    expect(log).toHaveBeenCalledWith('Debug logging topics: plan, price');
  });

  it('falls back to legacy toggle when no topics are configured', () => {
    const settings = {
      get: jest.fn((key: string) => (key === DEBUG_LOGGING_TOPICS ? [] : true)),
    } as any;
    const result = buildDebugLoggingTopics({ settings, log: jest.fn() });

    expect(result.size).toBe(ALL_DEBUG_LOGGING_TOPICS.length);
  });

  it('logs disabled when nothing is enabled', () => {
    const settings = {
      get: jest.fn((key: string) => (key === DEBUG_LOGGING_TOPICS ? [] : false)),
    } as any;
    const log = jest.fn();

    const result = buildDebugLoggingTopics({ settings, log, logChange: true });

    expect(result.size).toBe(0);
    expect(log).toHaveBeenCalledWith('Debug logging topics: disabled');
  });
});

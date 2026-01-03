import { ALL_DEBUG_LOGGING_TOPICS, normalizeDebugLoggingTopics } from '../lib/utils/debugLogging';

describe('normalizeDebugLoggingTopics', () => {
  it('filters arrays to known topics', () => {
    const result = normalizeDebugLoggingTopics(['plan', 'nope', 123, 'settings']);
    expect(result).toEqual(['plan', 'settings']);
  });

  it('maps object flags into topic names', () => {
    const result = normalizeDebugLoggingTopics({
      plan: true,
      price: false,
      settings: true,
      bogus: true,
    });
    expect(result).toEqual(['plan', 'settings']);
  });

  it('returns empty list for invalid inputs', () => {
    expect(normalizeDebugLoggingTopics('plan')).toEqual([]);
    expect(normalizeDebugLoggingTopics(null)).toEqual([]);
    expect(normalizeDebugLoggingTopics(ALL_DEBUG_LOGGING_TOPICS[0])).toEqual([]);
  });
});

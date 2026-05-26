import {
  ALL_DEBUG_LOGGING_TOPICS,
  DEBUG_LOGGING_SCENARIOS,
  normalizeDebugLoggingScenarioIds,
  normalizeDebugLoggingTopics,
  scenarioIdsToTopics,
  topicsToScenarioIds,
} from '../packages/shared-domain/src/utils/debugLogging';

describe('normalizeDebugLoggingTopics', () => {
  it('filters arrays to known topics', () => {
    const result = normalizeDebugLoggingTopics([
      'plan',
      'diagnostics',
      'objective_profiles',
      'deferred_objectives',
      'nope',
      123,
      'settings',
    ]);
    expect(result).toEqual(['plan', 'diagnostics', 'objective_profiles', 'deferred_objectives', 'settings']);
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

  it('rejects the retired overview2 topic id', () => {
    expect(ALL_DEBUG_LOGGING_TOPICS).not.toContain('overview2' as never);
    expect(normalizeDebugLoggingTopics(['plan', 'overview2'])).toEqual(['plan']);
  });
});

describe('scenarioIdsToTopics', () => {
  it('returns the union of topics across selected scenarios, deduped, in topic-list order', () => {
    const topics = scenarioIdsToTopics(['deadline_objectives', 'price_decisions']);
    expect(topics).toEqual([
      'plan',
      'price',
      'daily_budget',
      'objective_profiles',
      'power_calibration',
      'deferred_objectives',
    ]);
  });

  it('returns an empty list when no scenarios are selected', () => {
    expect(scenarioIdsToTopics([])).toEqual([]);
  });

  it('matches every documented scenario to a known topic set', () => {
    DEBUG_LOGGING_SCENARIOS.forEach((scenario) => {
      const topics = scenarioIdsToTopics([scenario.id]);
      expect(topics).toEqual(expect.arrayContaining([...scenario.topics]));
      expect(topics.length).toBe(scenario.topics.length);
    });
  });
});

describe('topicsToScenarioIds', () => {
  it('matches a scenario only when every one of its topics is present', () => {
    const { matched, unmatched } = topicsToScenarioIds(['plan', 'diagnostics', 'devices']);
    expect(matched).toContain('capacity_limits');
    expect(unmatched).toEqual([]);
  });

  it('reports unmatched topics that no fully-matched scenario covers', () => {
    const { matched, unmatched } = topicsToScenarioIds(['perf', 'plan']);
    expect(matched).toEqual(['performance']);
    expect(unmatched).toEqual(['plan']);
  });

  it('returns no matches when topic set is partial for every scenario', () => {
    const { matched, unmatched } = topicsToScenarioIds(['plan']);
    expect(matched).toEqual([]);
    expect(unmatched).toEqual(['plan']);
  });

  it('handles empty input', () => {
    expect(topicsToScenarioIds([])).toEqual({ matched: [], unmatched: [] });
  });
});

describe('normalizeDebugLoggingScenarioIds', () => {
  it('keeps known scenario ids and drops the rest', () => {
    expect(
      normalizeDebugLoggingScenarioIds(['deadline_objectives', 'nope', 42, 'performance']),
    ).toEqual(['deadline_objectives', 'performance']);
  });

  it('returns empty list for non-arrays', () => {
    expect(normalizeDebugLoggingScenarioIds('deadline_objectives')).toEqual([]);
    expect(normalizeDebugLoggingScenarioIds(null)).toEqual([]);
  });
});

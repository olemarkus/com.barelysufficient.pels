export const DEBUG_LOGGING_TOPICS = [
  { id: 'plan', label: 'Plan engine', description: 'Power limiting, resuming, and safe pace decisions.' },
  { id: 'overview', label: 'Overview', description: 'UI-visible per-device overview transition logging.' },
  {
    id: 'diagnostics',
    label: 'Device diagnostics',
    description: 'Per-device starvation, hysteresis, penalty, and diagnostics persistence.',
  },
  { id: 'price', label: 'Price optimization', description: 'Spot prices, tariffs, and price shaping.' },
  { id: 'daily_budget', label: 'Daily budget', description: 'Daily plan and rollover.' },
  {
    id: 'objective_profiles',
    label: 'Objective profiles',
    description: 'Learned temperature and EV progress profiling diagnostics.',
  },
  {
    id: 'power_calibration',
    label: 'Power calibration',
    description: 'Per-device step power calibration samples and drops.',
  },
  {
    id: 'deferred_objectives',
    label: 'Ready-by-time diagnostics',
    description: 'Ready-by-time planning diagnostics.',
  },
  { id: 'devices', label: 'Devices', description: 'Device snapshots and Homey API interactions.' },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Settings checks and updates, including expected power flow cards.',
  },
  { id: 'perf', label: 'Performance', description: 'Hotpath counters and timings.' },
] as const;

export type DebugLoggingTopic = typeof DEBUG_LOGGING_TOPICS[number]['id'];

export const ALL_DEBUG_LOGGING_TOPICS: DebugLoggingTopic[] = DEBUG_LOGGING_TOPICS.map((topic) => topic.id);

export const DEBUG_LOGGING_SCENARIOS = [
  {
    id: 'deadline_objectives',
    label: 'Deadline & objectives',
    description:
      'Why a smart task or EV did not finish on time. Planner, ready-by-time horizon, '
      + 'learned progress, step power calibration, and daily budget.',
    topics: ['plan', 'deferred_objectives', 'objective_profiles', 'power_calibration', 'daily_budget'],
  },
  {
    id: 'capacity_limits',
    label: 'Capacity limits',
    description:
      'Why a device was limited or resumed right now. Planner decisions, per-device diagnostics, '
      + 'and device state.',
    topics: ['plan', 'diagnostics', 'devices'],
  },
  {
    id: 'price_decisions',
    label: 'Price decisions',
    description:
      'Why a device ran at this hour and not another. Spot prices, daily budget shaping, '
      + 'and planner outcome.',
    topics: ['price', 'daily_budget', 'plan'],
  },
  {
    id: 'device_sync',
    label: 'Device sync & UI mismatch',
    description:
      'Homey shows one thing but PELS thinks another. Device snapshots, settings / expected-power '
      + 'events, and UI transition log.',
    topics: ['devices', 'settings', 'overview'],
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'App feels slow, or RSS is climbing. Hotpath counters and timings.',
    topics: ['perf'],
  },
] as const;

export type DebugLoggingScenarioId = typeof DEBUG_LOGGING_SCENARIOS[number]['id'];

export const ALL_DEBUG_LOGGING_SCENARIO_IDS: DebugLoggingScenarioId[]
  = DEBUG_LOGGING_SCENARIOS.map((scenario) => scenario.id);

export const isDebugLoggingScenarioId = (value: unknown): value is DebugLoggingScenarioId => (
  typeof value === 'string'
  && (ALL_DEBUG_LOGGING_SCENARIO_IDS as readonly string[]).includes(value)
);

export const scenarioIdsToTopics = (
  scenarioIds: readonly DebugLoggingScenarioId[],
): DebugLoggingTopic[] => {
  const set = new Set<DebugLoggingTopic>();
  scenarioIds.forEach((id) => {
    const scenario = DEBUG_LOGGING_SCENARIOS.find((entry) => entry.id === id);
    scenario?.topics.forEach((topic) => set.add(topic));
  });
  const order = new Map(ALL_DEBUG_LOGGING_TOPICS.map((topic, index) => [topic, index]));
  return [...set].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
};

export const topicsToScenarioIds = (
  topics: readonly DebugLoggingTopic[],
): { matched: DebugLoggingScenarioId[]; unmatched: DebugLoggingTopic[] } => {
  const present = new Set(topics);
  const matched: DebugLoggingScenarioId[] = [];
  const usedByMatched = new Set<DebugLoggingTopic>();
  DEBUG_LOGGING_SCENARIOS.forEach((scenario) => {
    if (scenario.topics.every((topic) => present.has(topic))) {
      matched.push(scenario.id);
      scenario.topics.forEach((topic) => usedByMatched.add(topic));
    }
  });
  const unmatched = topics.filter((topic) => !usedByMatched.has(topic));
  return { matched, unmatched };
};

export const normalizeDebugLoggingTopics = (raw: unknown): DebugLoggingTopic[] => {
  if (Array.isArray(raw)) {
    return raw.filter((value): value is DebugLoggingTopic => (
      typeof value === 'string'
      && (ALL_DEBUG_LOGGING_TOPICS as readonly string[]).includes(value)
    ));
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .filter((value): value is DebugLoggingTopic => (
        (ALL_DEBUG_LOGGING_TOPICS as readonly string[]).includes(value)
      ));
  }
  return [];
};

export const normalizeDebugLoggingScenarioIds = (raw: unknown): DebugLoggingScenarioId[] => {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isDebugLoggingScenarioId);
};

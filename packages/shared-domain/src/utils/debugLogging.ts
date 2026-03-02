export const DEBUG_LOGGING_TOPICS = [
  { id: 'plan', label: 'Plan engine', description: 'Shedding, restore, and soft-limit decisions.' },
  { id: 'price', label: 'Price optimization', description: 'Spot prices, tariffs, and price shaping.' },
  { id: 'daily_budget', label: 'Daily budget', description: 'Daily plan and rollover.' },
  { id: 'devices', label: 'Devices', description: 'Device snapshots and Homey API interactions.' },
  { id: 'settings', label: 'Settings', description: 'Settings changes and housekeeping.' },
  { id: 'perf', label: 'Performance', description: 'Hotpath counters and timings.' },
] as const;

export type DebugLoggingTopic = typeof DEBUG_LOGGING_TOPICS[number]['id'];

export const ALL_DEBUG_LOGGING_TOPICS: DebugLoggingTopic[] = DEBUG_LOGGING_TOPICS.map((topic) => topic.id);

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

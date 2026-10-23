import type { DailyBudgetManagerDeps } from '../../lib/dailyBudget/dailyBudgetManagerTypes';

/**
 * Manager deps for a spec that is not about its debug output: the topic reads
 * as on, so the logging paths run as they do with debugging enabled, and both
 * sinks discard. A spec about the output passes its own sink or gate.
 */
export const dailyBudgetManagerDeps = (
  overrides: Partial<DailyBudgetManagerDeps> = {},
): DailyBudgetManagerDeps => ({
  isDebugTopicEnabled: () => true,
  structuredDebug: () => undefined,
  debugStructured: () => undefined,
  ...overrides,
});

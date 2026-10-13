import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../../contracts/src/deferredObjectivePlanHistory.ts';
import { toResolvedLegacyPlanHistoryEntry } from '../../../../test/utils/planHistoryFixtures.ts';

export const planHistoryEntry = (): ResolvedDeferredObjectivePlanHistoryEntry => toResolvedLegacyPlanHistoryEntry({
  id: 'history-1',
  originalPlan: null,
  finalPlan: null,
  deviceId: 'heater',
  deviceName: 'Heater',
  objectiveKind: 'temperature',
  progressDirection: 'increasing',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: Date.UTC(2026, 4, 6, 6),
  startedAtMs: Date.UTC(2026, 4, 6),
  finalizedAtMs: Date.UTC(2026, 4, 6, 6),
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 22.5,
  outcome: 'met',
  metAtMs: Date.UTC(2026, 4, 6, 4, 42),
  usedDeadlineReserve: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
});

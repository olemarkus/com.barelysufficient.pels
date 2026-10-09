import type {
  DeferredObjectivePlanHistoryEntry,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../packages/contracts/src/deferredObjectivePlanHistory';
import { toResolvedPlanHistoryEntry } from '../../packages/shared-domain/src/deferredPlanHistoryResolvedView';

/**
 * Resolves a self-describing legacy fixture row, taking the device name and
 * objective kind from the row itself. Production resolves with current device
 * data through `toResolvedPlanHistoryEntry`.
 */
export const toResolvedLegacyPlanHistoryEntry = (
  entry: DeferredObjectivePlanHistoryEntry,
): ResolvedDeferredObjectivePlanHistoryEntry => toResolvedPlanHistoryEntry(entry, {
  name: entry.deviceName === null ? entry.deviceId : entry.deviceName,
  objectiveKind: entry.objectiveKind,
});

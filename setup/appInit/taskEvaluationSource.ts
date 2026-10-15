import type { AppContext } from '../../lib/app/appContext';
import type { ModePriorityOrder } from '../../packages/shared-domain/src/settings/modePriorities';
import type { TaskEvaluationSource } from '../../lib/objectives/deferredObjectives';
import { buildPriceHorizonFromCombined } from '../../lib/price/priceStore';
import { requirePlanService, requirePriceCoordinator } from './contextGuards';
import {
  requireDeferredObjectiveActivePlanRecorder,
  requireDeferredObjectiveEnergyDelivery,
  requireDeferredObjectivePlanHistoryRecorder,
} from './deferredRecorders';
import { resolveSmartTaskDeviceExclusion } from './smartTaskHomeScope';

/**
 * The one binding of what the main home's smart-task evaluations read. The
 * service wiring builds it once and hands the instance to the plan engine's
 * decoration lane, the lifecycle clock and the create-task preview, so the
 * three differ only in the per-cycle inputs they hand the snapshot (clock,
 * devices, objective roster, daily budget). Every member is a live closure,
 * re-read on each call, so building the source before the price and plan
 * services exist is safe.
 */
export const buildTaskEvaluationSource = (
  ctx: AppContext,
  getPrioritiesForDevices: (deviceIds: readonly string[]) => ModePriorityOrder,
): TaskEvaluationSource => ({
  getTimeZone: () => ctx.getTimeZone(),
  getThermalDirection: (deviceId) => ctx.observer.getThermalDirection(deviceId),
  getPowerTracker: () => ctx.powerTracker,
  getPriceOptimizationEnabled: () => requirePriceCoordinator(ctx).getPriceOptimizationEnabled(),
  getDeferredObjectiveActivePlans: () => requireDeferredObjectiveActivePlanRecorder(ctx).getActivePlansSnapshot(),
  getCapacitySettings: () => ctx.capacitySettings,
  hasSolarProduction: () => ctx.deviceReads.hasProductionCandidate(),
  // The allocation-horizon price grid, resolved directly from the price layer (a
  // legacy V1 payload is migrated to V2 on read) so the leafward objectives
  // subsystem never imports `lib/price`.
  buildPriceHorizon: (nowMs, deadlineAtMs) => buildPriceHorizonFromCombined(
    requirePriceCoordinator(ctx).combinedPricesReader.readStore(ctx.getNow(), ctx.getTimeZone()),
    nowMs,
    deadlineAtMs,
  ),
  getPrioritiesForDevices,
  // A device out of the main planning lane resolves to its own dedicated
  // unknown diagnostic (never planned) instead of masquerading as a missing
  // device: `objective_device_in_sub_home` for multi-home v1 scope,
  // `objective_device_unmanaged` when the owner turned "Managed by PELS" off.
  // Membership absent (boot window / bare test contexts) with no sub-homes and
  // no explicit opt-out → `null` for every device, preserving exact
  // single-home behavior.
  resolveDeviceExclusion: (deviceId) => resolveSmartTaskDeviceExclusion(ctx, deviceId),
  hasObservedTask: (deviceId, objective) => (
    requireDeferredObjectivePlanHistoryRecorder(ctx).hasObservedTask(deviceId, objective)
  ),
  getStallClassification: (deviceId) => requirePlanService(ctx).getStallEvidence(deviceId),
  // The count the lifecycle clock books, read lazily: the tracker is built
  // with the plan runtime.
  getDeliveredEnergyKWh: (deviceId, deadlineAtMs) => (
    requireDeferredObjectiveEnergyDelivery(ctx).getDeliveredKWh(deviceId, deadlineAtMs)
  ),
  isReservationSuppressed: (deviceId, deadlineAtMs) => (
    requireDeferredObjectivePlanHistoryRecorder(ctx).isReservationSuppressed(deviceId, deadlineAtMs)
  ),
});

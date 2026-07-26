import type { AppContext } from '../lib/app/appContext';
import type { DeferredObjectivePlanHistoryEntry } from '../packages/contracts/src/deferredObjectivePlanHistory';
import type { ResolvedDeferredObjectiveActivePlansV1 } from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { SettingsUiDeferredObjectivePlanHistoryPayload } from '../packages/contracts/src/settingsUiApi';
import { toResolvedPlanHistoryEntry } from '../packages/shared-domain/src/deferredPlanHistoryResolvedView';
import { assembleActivePlansWithTrajectory } from './deferredObjectiveActivePlansUiAssembler';

/**
 * The two `AppContext` members this projection reads. Narrowed on purpose: the
 * class needs nothing else, and the narrow type lets a test build a real
 * (non-cast) context.
 */
export type SmartTaskPayloadsContext = Pick<
  AppContext,
  'deferredObjectiveActivePlanRecorder' | 'deferredObjectivePlanHistoryRecorder'
>;

/**
 * Read-only smart-task payload assembly for the settings UI and the widgets:
 * the active-plans view and the finalized plan history. Strictly a projection
 * over the two recorders — no writes, no planner re-entry. The write/preview
 * lanes live next door in `appSmartTaskApi.ts`.
 */
export class AppSmartTaskPayloads {
  constructor(private readonly ctx: SmartTaskPayloadsContext) {}

  public getDeferredObjectiveActivePlansUiPayload(): ResolvedDeferredObjectiveActivePlansV1 | null {
    const snapshot = this.ctx.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null;
    if (snapshot === null) return null;
    // Stitch live in-progress trajectory (start progress + observed samples)
    // onto the snapshot for the smart-tasks widget chart. UI-only — never
    // persisted (see the assembler + the field doc on the contract).
    return assembleActivePlansWithTrajectory(snapshot, this.ctx.deferredObjectivePlanHistoryRecorder);
  }

  private buildPlanHistoryUiPayload(
    accept?: (entry: DeferredObjectivePlanHistoryEntry) => boolean,
  ): SettingsUiDeferredObjectivePlanHistoryPayload {
    const snapshot = this.ctx.deferredObjectivePlanHistoryRecorder?.getHistorySnapshot();
    const entriesByDeviceId: SettingsUiDeferredObjectivePlanHistoryPayload['entriesByDeviceId'] = {};
    if (snapshot) {
      // Sort newest finalizedAtMs first within each device to match the UI expectation.
      const byDevice = new Map<string, DeferredObjectivePlanHistoryEntry[]>();
      for (const entry of snapshot.entries) {
        if (accept && !accept(entry)) continue;
        const list = byDevice.get(entry.deviceId) ?? [];
        list.push(entry);
        byDevice.set(entry.deviceId, list);
      }
      for (const [deviceId, list] of byDevice) {
        // Resolve kind-split °C/% pairs to unit-agnostic numbers at this producer boundary.
        entriesByDeviceId[deviceId] = list
          .sort((a, b) => b.finalizedAtMs - a.finalizedAtMs)
          .map(toResolvedPlanHistoryEntry);
      }
    }
    return { version: 1, entriesByDeviceId };
  }

  public getDeferredObjectivePlanHistoryUiPayload(): SettingsUiDeferredObjectivePlanHistoryPayload {
    return this.buildPlanHistoryUiPayload();
  }

  // Bounded variant for the smart-tasks widget: only entries finalized at/after
  // `sinceMs`. The widget refreshes every 60 s and only renders the last 24 h, so
  // serializing the full (unbounded, all-time) history each cycle is wasteful —
  // this keeps the payload proportional to recent activity.
  public getDeferredObjectivePlanHistoryRecentUiPayload(
    sinceMs: number,
  ): SettingsUiDeferredObjectivePlanHistoryPayload {
    return this.buildPlanHistoryUiPayload(
      (entry) => Number.isFinite(entry.finalizedAtMs) && entry.finalizedAtMs >= sinceMs,
    );
  }
}

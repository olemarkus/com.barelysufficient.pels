/**
 * Signature-change tracking for a plan rebuild. Extracted from `PlanService`
 * (slice: change detection) so the rebuild orchestration stays readable. Owns
 * the last-seen action/detail/meta/debug-summary signatures and emits the
 * deduped structured plan-debug-summary event when it moves. Pure state holder:
 * no actuation, no snapshot mutation. Behaviour is identical to the former
 * `PlanService.trackPlanChanges` / `resolveDebugSummaryState` methods.
 */
import { incPerfCounter } from '../utils/perfCounters';
import { getLogger } from '../logging/logger';
import type { StructuredDebugEmitter } from '../logging/logger';
import {
  buildPlanDebugSummaryEvent,
  buildPlanDebugSummarySignatureFromEvent,
  buildPlanDetailSignature,
  buildPlanSignature,
} from './planLogging';
import type { DevicePlan, PlanChangeSet } from './planTypes';

const logger = getLogger('plan/service');

type PlanChangeTrackerDeps = {
  debugStructured?: StructuredDebugEmitter;
  isPlanDebugEnabled?: () => boolean;
};

type DebugSummaryState = {
  event: ReturnType<typeof buildPlanDebugSummaryEvent> | null;
  signature: string | null;
  changed: boolean;
  emitted: boolean;
};

export class PlanChangeTracker {
  private lastActionPlanSignature = '';
  private lastDetailPlanSignature = '';
  private lastPlanMetaSignature = '';
  private lastPlanDebugSummarySignature = '';

  constructor(private deps: PlanChangeTrackerDeps) {}

  track(plan: DevicePlan, metaSignature: string): PlanChangeSet {
    const actionSignature = buildPlanSignature(plan);
    const detailSignature = buildPlanDetailSignature(plan);
    const actionChanged = actionSignature !== this.lastActionPlanSignature;
    const detailChanged = detailSignature !== this.lastDetailPlanSignature;
    const metaChanged = metaSignature !== this.lastPlanMetaSignature;
    const debugSummaryState = this.resolveDebugSummaryState({
      plan,
      actionChanged,
      detailChanged,
      metaChanged,
    });

    if (actionChanged) {
      incPerfCounter('plan_rebuild_action_signature_changed_total');
    } else if (detailChanged || metaChanged) {
      incPerfCounter('plan_rebuild_reason_or_meta_only_changed_total');
      if (detailChanged) {
        incPerfCounter('plan_rebuild_reason_or_state_only_changed_total');
      }
      if (metaChanged) {
        incPerfCounter('plan_rebuild_meta_only_changed_total');
      }
    } else {
      incPerfCounter('plan_rebuild_no_change_total');
    }

    if (debugSummaryState.changed && debugSummaryState.event) {
      const emit = this.deps.debugStructured ?? ((p: Record<string, unknown>) => logger.debug(p));
      emit(debugSummaryState.event);
    }

    this.lastActionPlanSignature = actionSignature;
    this.lastDetailPlanSignature = detailSignature;
    this.lastPlanMetaSignature = metaSignature;
    if (debugSummaryState.emitted && debugSummaryState.signature !== null) {
      this.lastPlanDebugSummarySignature = debugSummaryState.signature;
    }

    return {
      actionSignature,
      detailSignature,
      metaSignature,
      actionChanged,
      detailChanged,
      metaChanged,
    };
  }

  private resolveDebugSummaryState(params: {
    plan: DevicePlan;
    actionChanged: boolean;
    detailChanged: boolean;
    metaChanged: boolean;
  }): DebugSummaryState {
    const { plan, actionChanged, detailChanged, metaChanged } = params;
    const shouldCheck = (actionChanged || detailChanged || metaChanged)
      && Boolean(this.deps.debugStructured)
      && (this.deps.isPlanDebugEnabled?.() ?? true);
    if (!shouldCheck) {
      return { event: null, signature: null, changed: false, emitted: false };
    }
    const event = buildPlanDebugSummaryEvent(plan);
    const signature = buildPlanDebugSummarySignatureFromEvent(event);
    return {
      event,
      signature,
      changed: signature !== this.lastPlanDebugSummarySignature,
      emitted: true,
    };
  }
}

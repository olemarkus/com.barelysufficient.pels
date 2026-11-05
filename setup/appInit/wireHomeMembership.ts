import type { HomeMembershipService } from '../../lib/home/homeMembershipService';
import type { AppContext } from '../../lib/app/appContext';
import { createSampledMeterIdentity } from './createSampledMeterIdentity';
import { normalizeError } from '../../lib/utils/errorUtils';
import {
  wireHomeMembershipService,
  type HomeMembershipWiring,
  type HomeMembershipWiringParams,
} from '../homeMembershipWiring';
import { MainOwnershipRecovery, type OwnershipGenerationRuntime } from '../../lib/home/mainOwnershipRecovery';
export type { OwnershipGenerationRuntime } from '../../lib/home/mainOwnershipRecovery';

export type WireHomeMembershipOptions = {
  onOwnershipReadyBeforePlanWork?: (allowPendingOwnershipGeneration: boolean) => void;
  onZoneTreeCommitReady?: () => void;
  onSubHomeMembershipChanged?: () => boolean;
  ownershipGenerationRuntime?: OwnershipGenerationRuntime;
};

/**
 * Boot-wire the multi-home membership cache over the ctx seams: real stores,
 * the transport's zone tree + zone-tree-commit callback, and the latest
 * target snapshot. Runs after `initDeviceManager` so the recompute triggers
 * ride the transport-owned notification seams; zone-tree and device reads are
 * lazy closures, so an unpopulated transport resolves fail-safe. `lib/home`
 * owns the settings stores. The control path
 * consumes membership through `filterDevicesForHome` — main's plan input
 * (`setup/homeRuntime/homeScope.ts`) and the sample-pipeline snapshot view
 * (`setup/homeRuntime/createHomePowerPipeline.ts`).
 *
 * The caller (`AppServiceWiring.initHomeMembership`) assigns the returned
 * `service` to `ctx.homeMembership` and invokes `teardown` in `runUninit`.
 */
export const wireHomeMembership = (
  ctx: AppContext,
  subscribeToObservedStateRefresh: HomeMembershipWiringParams['subscribeToObservedStateRefresh'],
  options: WireHomeMembershipOptions = {},
): HomeMembershipWiring & {
  requestMainAuthorityRecovery: (timing?: 'scheduled' | 'immediate') => void;
} => {
  const {
    onOwnershipReadyBeforePlanWork,
    onZoneTreeCommitReady,
    onSubHomeMembershipChanged,
    ownershipGenerationRuntime,
  } = options;
  let service: HomeMembershipService | undefined = undefined;
  const recovery = new MainOwnershipRecovery(
    ctx,
    () => service,
    ownershipGenerationRuntime,
    onOwnershipReadyBeforePlanWork,
  );
  const wiring = wireHomeMembershipService({
    settings: ctx.homey.settings,
    sampledMeterIdentity: createSampledMeterIdentity(ctx),
    subscribeToObservedStateRefresh,
    onZoneTreeCommitReady,
    onMainOwnershipReady: recovery.applyNow,
    onMainAuthorityUnresolved: recovery.schedule,
    // A repaired sampled-meter fence still leaves a committed plan derived
    // under the old provenance. Advance the ownership generation synchronously
    // before the authority latch opens; that generation is the takeover fence
    // while the normal bounded recovery rebuilds and reconciles a fresh plan.
    // `observeOwnershipConfigurationChanged` schedules through the existing
    // unresolved-authority callback, so recovery remains deferred off the
    // sample-dispatch stack.
    onMainAuthorityReopened: () => service?.observeOwnershipConfigurationChanged(),
    onOwnershipReadyBeforePlanWork,
    setOnZoneTreeCommitted: (callback) => ctx.deviceManager?.setOnZoneTreeCommitted(callback),
    setOnDeviceZoneChanged: (callback) => ctx.deviceManager?.setOnDeviceZoneChanged(callback),
    getZoneTree: () => ctx.deviceManager?.getZoneTree() ?? null,
    // The membership join asks for exactly what it needs — `id` + `zoneId`, both
    // stamped at parse — and nothing decorates on the way. NOT
    // `ctx.getPlanInputSnapshot()`: that getter projects and decorates every device
    // per access, and a membership recompute must stay a pure, cheap read. (It
    // used to be a side-EFFECTING read too — the decorator settled stepped
    // commands — which is what `homeMembershipService.test.ts` pins with a ctx
    // stub exposing only the members this may touch. The settling moved to
    // `lib/executor/syncSteppedCommands.ts`; the cost argument is what survives.)
    getDevices: () => ctx.deviceReads.zoneMemberships(),
    getLogger: () => ctx.getStructuredLogger('homes'),
    // Change-gated plan invalidation, mirroring the settings-change rebuild
    // path (`rebuildPlanFromSettings` → `planService.rebuildPlanFromCache`): a
    // changed membership map means the committed plan governs the wrong device
    // set — worst in flow mode, where no sample-driven rebuild is guaranteed.
    onMembershipChanged: () => {
      // A settings-generation recovery owns the full fresh Main/sub-home build
      // and reconcile. Do not enqueue duplicate stale-plan work from the
      // intermediate semantic recompute.
      if (service?.hasPendingOwnershipGeneration()) return;
      if (onSubHomeMembershipChanged?.() === false) return;
      const planService = ctx.planService;
      if (!planService) {
        // Honest skip, never silent: the change-gate cannot fire on the first
        // resolution, so an absent plan service here is a wiring-order
        // regression (membership changed before the plan wiring exists) — the
        // committed plan, if any, keeps governing until the next rebuild
        // trigger. Warn so the regression is diagnosable from logs.
        ctx.getStructuredLogger('homes').warn({
          event: 'home_membership_rebuild_skipped_unwired',
        });
        return;
      }
      void planService.rebuildPlanFromCache('home_membership_changed')
        .catch((error: unknown) => ctx.getStructuredLogger('homes').error({
          event: 'home_membership_plan_rebuild_failed',
          err: normalizeError(error),
        }));
    },
  });
  service = wiring.service;
  if (!service.isOwnershipReady()) recovery.schedule();
  return {
    service: wiring.service,
    requestMainAuthorityRecovery: (timing = 'scheduled') => {
      if (timing === 'immediate') recovery.applyNow();
      else recovery.schedule();
    },
    teardown: () => {
      recovery.stop();
      wiring.teardown();
    },
  };
};

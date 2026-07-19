import type { AppContext } from '../../lib/app/appContext';
import type { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import { normalizeError } from '../../lib/utils/errorUtils';
import { createHomeMembershipService, type HomeMembershipWiring } from '../homeMembership';

/**
 * Boot-wire the multi-home membership cache over the ctx seams: real stores,
 * the transport's zone tree + zone-tree-commit callback, and the latest
 * target snapshot. Runs after `initDeviceManager` so the recompute triggers
 * ride the transport-owned notification seams; the reads are lazy closures,
 * so a not-yet-populated transport resolves fail-safe. Read-only over the
 * stores; the control path consumes it through `filterDevicesForHome` — main's
 * plan input (`setup/homeRuntime/homeScope.ts`) and the sample-pipeline
 * snapshot view (`setup/homeRuntime/createHomePowerPipeline.ts`).
 *
 * The caller (`AppServiceWiring.initHomeMembership`) assigns the returned
 * `service` to `ctx.homeMembership` and invokes `teardown` in `runUninit`.
 */
export const wireHomeMembership = (
  ctx: AppContext,
  emitter: ObservedStateEmitter,
): HomeMembershipWiring => createHomeMembershipService({
  homey: ctx.homey,
  emitter,
  setOnZoneTreeCommitted: (callback) => ctx.deviceManager?.setOnZoneTreeCommitted(callback),
  setOnDeviceZoneChanged: (callback) => ctx.deviceManager?.setOnDeviceZoneChanged(callback),
  getZoneTree: () => ctx.deviceManager?.getZoneTree() ?? null,
  // The RAW transport snapshot on purpose, NOT `ctx.latestTargetSnapshot`:
  // the decorated path (`decorateTargetSnapshotList`) mutates stepped-load
  // runtime state (prune/expire/confirm) as a side effect, and a membership
  // recompute must be a pure read. The join needs only `id` + `zoneId`, both
  // stamped on the raw snapshot at parse (R3).
  getDevices: () => (ctx.deviceManager?.getSnapshot() ?? []).map((device) => ({
    deviceId: device.id,
    zoneId: device.zoneId ?? null,
  })),
  getLogger: () => ctx.getStructuredLogger('homes'),
  // Change-gated plan invalidation, mirroring the settings-change rebuild
  // path (`rebuildPlanFromSettings` → `planService.rebuildPlanFromCache`): a
  // changed membership map means the committed plan governs the wrong device
  // set — worst in flow mode, where no sample-driven rebuild is guaranteed.
  onMembershipChanged: () => {
    const planService = ctx.planService;
    if (!planService) {
      // Honest skip, never silent: the change-gate cannot fire on the first
      // resolution, so an absent plan service here is a wiring-order
      // regression (membership changed before the plan wiring exists) — the
      // committed plan, if any, keeps governing until the next rebuild
      // trigger. Warn so the regression is diagnosable from logs.
      ctx.getStructuredLogger('homes')?.warn({
        event: 'home_membership_rebuild_skipped_unwired',
      });
      return;
    }
    void planService.rebuildPlanFromCache('home_membership_changed')
      .catch((error: unknown) => ctx.getStructuredLogger('homes')?.error({
        event: 'home_membership_plan_rebuild_failed',
        err: normalizeError(error),
      }));
  },
});

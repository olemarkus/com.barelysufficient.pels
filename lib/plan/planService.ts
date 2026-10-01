import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { normalizeError } from '../utils/errorUtils';
import { PLAN_STATUS_PUBLISHED_EVENT } from '../utils/settingsKeys';
import { buildPlanDetailSignature } from './planLogging';
import { createPlanRebuildOutcome } from './planRebuildMetrics';
import { getLogger } from '../logging/logger';
import { runWithContext } from '../logging/alsContext';
import type {
  SettingsUiDeviceLogPayload,
  SettingsUiPlanSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import { buildSettingsOverviewReadModel } from './settingsOverviewReadModel';
import {
  createIdleClassifier,
  type IdleClassifier,
  type IdleClassifierDeviceInput,
} from '../observer/idleClassifier';
import type { StallEvidence } from '../../packages/contracts/src/idleClassification';
import type { PendingBinaryLiveDevice } from '../observer/pendingBinaryCommands';
import { PlanStatusWriter } from './planStatusWriter';
import { buildLiveStatePlan } from './planLiveStateMerge';
import type {
  DevicePlan,
  PendingTargetObservationSource,
  PlanChangeSet,
  PlanInputDevice,
  PlanRebuildOutcome,
  StatusPlanChanges,
} from './planTypes';
import type {
  HeadroomCardDeviceLike,
  HeadroomCardQuery,
  HeadroomForDeviceDecision,
} from './planHeadroomDevice';
import { PlanChangeTracker } from './planChangeTracker';
import { DeviceOverviewTransitions } from './planOverviewEmit';
import type { OverviewDecisionFacts } from './deviceOverviewLog';
import { performPlanRebuild, type PlanRebuildHost } from './planServiceRebuild';
import type { PlanRebuildRequestOptions, PlanRebuildTrigger } from './planRebuildTrigger';
import type { PlanServiceDeps } from './planServiceDeps';
import type { PublishedPlan } from './publishedPlan';
import type { DeviceExecutionState } from '../../packages/contracts/src/deviceStatus';
/**
 * Rebuild orchestration for the planning layer: PlanService owns WHEN a plan
 * is rebuilt and everything around the build, never WHAT the plan decides —
 * shed/restore decisions belong to `PlanEngine`/`PlanBuilder`, to which every
 * build and actuation call is forwarded. Invariants callers can rely on:
 * plan operations (rebuild, live-state sync, manual shed) are serialized through
 * one promise queue (`syncLivePlanStateInline` runs un-queued by design — the
 * executor invokes it inside an already-queued actuation); the first rebuild
 * is held behind the snapshot warmup gate (snapshot-ready or bounded timeout),
 * so the first plan normally sees a populated snapshot — downstream code must
 * still tolerate an empty one on the timeout path; and on rebuild, actuation
 * only happens when the plan's action signature changed (or the executor
 * reports stable-plan actuation) — detail/meta-only changes update snapshots,
 * status, and logs without touching devices. This class also owns the published plan snapshots the
 * settings UI and flow layer read, the `PlanStatusWriter`, and the
 * signature-deduped structured rebuild/overview logging.
 *
 * There is ONE way to converge a device: `rebuildPlanFromCache` runs the full
 * builder pipeline and then actuates if the plan's actions changed or the
 * executor still has work outstanding against the plan just built. A drifting
 * device is an ordinary planner input — it gets re-decided, not re-asserted.
 *
 * There used to be a second, cheaper lane (`reconcileLatestPlanState`) that
 * re-applied the EXISTING committed plan without re-deciding it. It is gone: a
 * plan that predates the observation which triggered it has not been decided
 * against that observation, and re-applying one breached the hard cap in
 * production (inc_26449fb9). Do not reintroduce an apply-without-
 * decide path here; if a rebuild is too slow for some caller, make the rebuild
 * cheaper.
 *
 * `syncLivePlanState*` is cheaper than a rebuild and remains: it settles pending
 * command bookkeeping and refreshes the published snapshot, with no actuation.
 *
 * The rebuild pipeline itself lives in `planServiceRebuild.ts` (driven through
 * the `PlanRebuildHost` seam built in the constructor); signature-change
 * tracking lives in `PlanChangeTracker`; device-overview transition emission in
 * `planOverviewEmit.ts`. This file keeps the serialized public surface plus the
 * reconcile/sync sequencing.
 *
 * Governing references: `docs/technical.md`, `lib/plan/AGENTS.md`.
 */

const logger = getLogger('plan/service');

export type { PlanServiceDeps } from './planServiceDeps';

/** A published overview together with the decision and executor state it was built from. */
type OverviewPublication = {
  snapshot: SettingsUiPlanSnapshot;
  plan: DevicePlan;
  execution: ReadonlyMap<string, DeviceExecutionState>;
};

const buildOverviewPublication = (
  plan: DevicePlan,
  deps: PlanServiceDeps,
  idleClassifier: IdleClassifier,
): OverviewPublication | null => {
  const execution = deps.planEngine.getDeviceExecutionStates(plan);
  const snapshot = buildSettingsOverviewReadModel(plan, {
    getDeviceExecutionState: (id) => {
      const value = execution.get(id);
      if (!value) throw new Error(`Missing execution state for ${id}`);
      return value;
    },
    dryRun: deps.readSimulationSetting(),
    nowMs: Date.now(),
    getOverviewStarvation: (deviceId) => deps.deviceDiagnostics?.getOverviewStarvation?.(deviceId),
    getIdleClassification: (deviceId) => idleClassifier.getClassification(deviceId),
    getObservedEvChargingState: deps.getObservedEvChargingState,
    getAssociatedCarChargingState: (deviceId) => deps.getAssociatedCarChargingState?.(deviceId),
    getObservedStateOfCharge: deps.getObservedStateOfCharge,
    getObservedTemperature: deps.getObservedTemperature,
    getSteppedLoadProfileById: deps.getSteppedLoadProfileById,
  });
  return snapshot ? { snapshot, plan, execution } : null;
};

// The decision and executor facts behind a presentation change, for the debug
// event only; the UI wire carries none of them. Every published device has both
// (the publication is built from this plan and its execution map), and the
// lookup is only built when a debug event asks for it.
const describeOverviewDecision = (
  publication: OverviewPublication,
): ((deviceId: string) => OverviewDecisionFacts) => {
  let devicesById: ReadonlyMap<string, DevicePlan['devices'][number]> | null = null;
  return (deviceId) => {
    devicesById ??= new Map(publication.plan.devices.map((device) => [device.id, device]));
    const device = devicesById.get(deviceId);
    const state = publication.execution.get(deviceId);
    if (!device || !state) throw new Error(`Missing decision for published device ${deviceId}`);
    return {
      reasonCode: device.reason.code, plannedState: device.plannedState,
      desiredStepId: state.desiredStepId, observedStepId: state.observedStepId,
      binaryProgress: state.binaryProgress, stepProgress: state.stepProgress, targetProgress: state.targetProgress,
    };
  };
};

export class PlanService {
  private latestPublishedPlan: PublishedPlan | null = null;
  private readonly overviewTransitions = new DeviceOverviewTransitions();
  private planOperationQueue: Promise<void> = Promise.resolve();
  private queuedRebuilds = 0;
  private planStatusWriter: PlanStatusWriter;
  private idleClassifier: IdleClassifier;
  private changeTracker: PlanChangeTracker;
  private readonly rebuildHost: PlanRebuildHost;
  private lastTickedPlanRef: DevicePlan | null = null;
  private readonly queuedLiveSyncs = new Map<PendingTargetObservationSource, Promise<boolean>>();

  constructor(private deps: PlanServiceDeps) {
    this.idleClassifier = createIdleClassifier({
      structuredLog: deps.loggers?.structuredLog,
      debugStructured: deps.loggers?.debugStructured,
    });
    this.planStatusWriter = new PlanStatusWriter({
      homey: deps.homey,
      publishPelsStatus: deps.publishPelsStatus,
      getCurrentHourPriceLevel: deps.getCurrentHourPriceLevel,
      getLastPowerUpdate: deps.getLastPowerUpdate,
      getCapacityDryRun: deps.getCapacityDryRun,
      structuredLog: deps.loggers?.structuredLog,
    });
    this.changeTracker = new PlanChangeTracker({
      debugStructured: deps.loggers?.debugStructured,
      isPlanDebugEnabled: deps.isPlanDebugEnabled,
    });
    this.rebuildHost = {
      deps,
      getLatestPlanSnapshot: () => this.getLatestPlanSnapshot(),
      getLatestPublishedPlan: () => this.latestPublishedPlan,
      publishPlan: (plan, publishedAtMs) => { this.latestPublishedPlan = { plan, publishedAtMs }; },
      settleDevices: () => this.settleDevices(),
      steppedSettleDevices: () => this.deps.getSteppedSettleDevices(),
      trackChanges: (plan, metaSignature) => this.changeTracker.track(plan, metaSignature),
      updatePlanSnapshot: (plan, changes) => this.updatePlanSnapshot(plan, changes),
      updatePelsStatus: (plan, changes) => this.updatePelsStatus(plan, changes),
      stampPlanGeneratedAt: (plan, nowMs) => this.stampPlanGeneratedAt(plan, nowMs),
      preservePlanGeneratedAt: (plan, basePlan) => this.preservePlanGeneratedAt(plan, basePlan),
      emitPlanUpdated: (plan) => this.emitPlanUpdated(plan),
    };
  }

  buildDevicePlanSnapshot(devices: PlanInputDevice[]): Promise<DevicePlan> {
    return this.deps.planEngine.buildDevicePlanSnapshot(devices);
  }

  private settleDevices(): PendingBinaryLiveDevice[] {
    return this.deps.getSettleDevices();
  }

  /**
   * The current live device inputs (snapshot projection). Exposed so the
   * clock-driven smart-task lifecycle emitter reads the same device source the
   * plan loop does, without re-implementing the projection.
   */
  getPlanDevices(): PlanInputDevice[] {
    return this.deps.getPlanDevices();
  }

  // Bridge from the observer-layer idle classifier into the plan layer.
  // Surfaced so the deferred-objective history recorder (lives in `lib/plan`,
  // wired in `appInit.ts`) can promote a smart task to `met` / `'stalled'`
  // when the device has settled near its setpoint. The classifier ticks
  // *after* plan emission (`tickIdleClassifier`), so on a given cycle the
  // recorder sees the state derived from the previous plan — that lag is
  // negligible against the 15-min `IDLE_UNRESPONSIVE_MIN_DURATION_MS`
  // window, but it does mean a fresh boot returns `undefined` until at
  // least one plan tick has run.
  // Carries the setpoint the verdict was measured against, not just the verdict:
  // PELS parks a managed device by writing a lower setback setpoint, and a device
  // idling at that setback is trivially `near_target_idle` while having delivered
  // nothing toward a higher smart-task target. Consumers gate on
  // `stallEvidenceCoversTarget`.
  getStallEvidence(
    deviceId: string,
  ): StallEvidence | undefined {
    return this.idleClassifier.getStallEvidence(deviceId);
  }

  computeDynamicSoftLimit(): number {
    return this.deps.planEngine.computeDynamicSoftLimit();
  }

  computeShortfallThreshold(): number {
    return this.deps.planEngine.computeShortfallThreshold();
  }

  // Recorded device-overview transitions for the settings-UI device-log view.
  // Empty when no recorder is wired (e.g. tests that omit the dep).
  getDeviceLogUiPayload(): SettingsUiDeviceLogPayload {
    return this.deps.deviceOverviewLogRecorder?.getUiPayload() ?? { version: 1, entriesByDeviceId: {} };
  }

  handleShortfall(deficitKw: number): Promise<void> {
    return this.withHomeLogContext(() => this.deps.planEngine.handleShortfall(deficitKw));
  }

  handleShortfallCleared(): Promise<void> {
    return this.withHomeLogContext(() => this.deps.planEngine.handleShortfallCleared());
  }


  getLatestPlanSnapshot(): DevicePlan | null {
    return this.latestPublishedPlan?.plan ?? null;
  }

  getLatestPublishedPlan(): PublishedPlan | null {
    return this.latestPublishedPlan;
  }

  /**
   * Whether the latest committed plan has this device limited BY SETPOINT.
   *
   * Asked by the mode-target adoption path, which must not save an owner's
   * reaction to a lowered (or, cooling, raised) temperature as the mode's
   * target. Deliberately narrower than the Overview's "Limited": a device PELS
   * turned off, or is holding for surplus or a start policy, has not had its
   * setpoint touched — a change the owner makes there is a preference the
   * executor would never write back over, so it is adopted as usual. No plan
   * yet means nothing is limited.
   */
  isDeviceLimitedInLatestPlan(deviceId: string): boolean {
    const plan = this.getLatestPlanSnapshot();
    if (plan === null) return false;
    return plan.devices.some(
      (device) => device.id === deviceId && device.plannedState === 'shed' && device.shedAction === 'set_temperature',
    );
  }

  getLatestPlanSnapshotForUi(): SettingsUiPlanSnapshot | null {
    const plan = this.getLatestPlanSnapshot();
    return plan ? buildOverviewPublication(plan, this.deps, this.idleClassifier)?.snapshot ?? null : null;
  }

  getLatestPlanSnapshotUpdatedAtMs(): number | null {
    return this.latestPublishedPlan?.publishedAtMs ?? null;
  }

  private stampPlanGeneratedAt(plan: DevicePlan, nowMs = Date.now()): DevicePlan {
    return {
      ...plan,
      generatedAtMs: nowMs,
    };
  }

  private preservePlanGeneratedAt(plan: DevicePlan, basePlan: DevicePlan): DevicePlan {
    return {
      ...plan,
      generatedAtMs: basePlan.generatedAtMs,
    };
  }

  /**
   * Observations arrive in bursts (every device's power, temperature and state
   * reports). A sync still waiting in the plan queue reads the latest state when
   * it runs, so later observations of the same source join it instead of
   * queueing another full status build. A sync that has started absorbs nothing.
   */
  syncLivePlanState(source: PendingTargetObservationSource): Promise<boolean> {
    const queued = this.queuedLiveSyncs.get(source);
    if (queued) return queued;
    const sync = this.enqueuePlanOperation(
      () => {
        this.queuedLiveSyncs.delete(source);
        return Promise.resolve(this.syncLivePlanStateInline(source));
      },
      'Failed to sync live plan state',
      false,
    );
    this.queuedLiveSyncs.set(source, sync);
    return sync;
  }

  syncLivePlanStateInline(source: PendingTargetObservationSource): boolean {
    return this.withHomeLogContext(() => this.syncLivePlanStateInlineInContext(source));
  }

  private syncLivePlanStateInlineInContext(source: PendingTargetObservationSource): boolean {
    // Ahead of the target/binary guard below, because that guard does not speak
    // for this axis: when a stepped command is the only thing in flight both of
    // its predicates are false, and a native rung or an on→off observation
    // arriving here would not settle until some later meter-driven rebuild. On
    // an irregular Flow feed that is a long time to leave `stepCommandPending`
    // set, suppressing retries for a device that has already reported. The
    // engine short-circuits internally when there is nothing tracked, so this
    // costs nothing in the common case.
    const steppedChanged = this.deps.planEngine.syncSteppedCommands(
      () => this.deps.getSteppedSettleDevices(),
    );

    const hasPendingTargetCommands = this.deps.planEngine.hasPendingTargetCommands();
    const hasPendingBinaryCommands = this.deps.planEngine.hasPendingBinaryCommands();
    if (!hasPendingTargetCommands && !hasPendingBinaryCommands) {
      return this.refreshDeviceStatus() || steppedChanged;
    }

    const liveDevices = this.deps.getPlanDevices();
    const pendingTargetChanged = hasPendingTargetCommands
      ? this.deps.planEngine.syncPendingTargetCommands(liveDevices, source)
      : false;
    const pendingBinaryChanged = hasPendingBinaryCommands
      ? this.deps.planEngine.syncPendingBinaryCommands(this.settleDevices(), source)
      : false;
    const pendingChanged = pendingTargetChanged || pendingBinaryChanged || steppedChanged;
    const current = this.getLatestPlanSnapshot();
    if (current === null) {
      return pendingChanged;
    }

    const livePlan = this.decoratePlanWithPendingTargetCommands(
      buildLiveStatePlan(
        current,
        liveDevices,
        (deviceId) => this.deps.planEngine.hasActiveBinaryTurnOnCommand(deviceId),
      ),
    );
    if (this.deps.planEngine.hasSettledActuation(current, livePlan)) {
      const refreshedPlan = this.preservePlanGeneratedAt(livePlan, current);
      this.latestPublishedPlan = { plan: refreshedPlan, publishedAtMs: Date.now() };
      this.emitPlanUpdated(refreshedPlan);
      return true;
    }

    if (!pendingChanged) {
      return this.refreshDeviceStatus();
    }

    const nextPlan = this.decoratePlanWithPendingTargetCommands(current);
    if (buildPlanDetailSignature(nextPlan) === buildPlanDetailSignature(current)) {
      return this.refreshDeviceStatus();
    }
    const refreshedPlan = this.preservePlanGeneratedAt(nextPlan, current);
    this.latestPublishedPlan = { plan: refreshedPlan, publishedAtMs: Date.now() };
    this.emitPlanUpdated(refreshedPlan);
    return true;
  }

  evaluateHeadroomForDevice(query: HeadroomCardQuery): HeadroomForDeviceDecision {
    return this.deps.planEngine.evaluateHeadroomForDevice(query);
  }

  syncHeadroomCardState(devices: HeadroomCardDeviceLike[]): void {
    this.deps.planEngine.syncHeadroomCardState(devices);
  }

  syncHeadroomUsageObservation(deviceId: string, usageKw: number): void {
    this.deps.planEngine.syncHeadroomUsageObservation(deviceId, usageKw);
  }

  /**
   * `shouldAbort` / `onAbort` are the serialized-queue TOCTOU guard (R7b P1).
   * This method only ENQUEUES; a caller may have validated a precondition (a
   * sub-home ready-edge's meter-sample revision) BEFORE enqueuing, but the body
   * runs LATER, when the queue drains, and a newer sample can land in between.
   * `shouldAbort` is re-checked at the point of use so a now-stale request drops
   * instead of actuating against an observation it never saw. A zeroed outcome
   * is indistinguishable from an ordinary no-op, so `onAbort` signals the
   * point-of-use abort DISTINCTLY — the ready-edge re-arms its latch on it (a
   * plain no-op must NOT re-arm). Callers passing neither are unaffected.
   */
  async rebuildPlanFromCache(
    trigger: PlanRebuildTrigger,
    options?: PlanRebuildRequestOptions,
  ): Promise<PlanRebuildOutcome> {
    const { detail, shouldAbort, onAbort } = options ?? {};
    // Hold the first rebuild until the warmup gate releases (snapshot ready
    // or bound elapsed). Awaiting here — before enqueuing — means the gate
    // does not block `enqueuePlanOperation` ordering and, once released,
    // subsequent rebuilds skip straight to the queue with no overhead.
    const gate = this.deps.snapshotWarmupGate;
    if (gate && !gate.isReleased()) {
      const waitStart = Date.now();
      await gate.wait();
      addPerfDuration('plan_rebuild_warmup_wait_ms', Date.now() - waitStart);
      incPerfCounter('plan_rebuild_warmup_waited_total');
    }
    // A closed build gate is a SKIP, not a wait: the trigger that asked for this
    // rebuild (a price update, a settings write, a device change) has no reason
    // to be held open indefinitely, and the sample that opens the gate schedules
    // its own rebuild when it lands. Skipping before enqueuing also keeps a
    // gated home off the plan operation queue entirely.
    if (!this.deps.planBuildGate.isOpen()) {
      incPerfCounter('plan_rebuild_gated_total');
      return { ...createPlanRebuildOutcome(this.deps.getCapacityDryRun()), gated: true };
    }
    const enqueuedAt = Date.now();
    this.queuedRebuilds += 1;
    const queueDepth = this.queuedRebuilds;
    incPerfCounter('plan_rebuild_enqueued_total');
    if (this.queuedRebuilds >= 2) {
      incPerfCounter('plan_rebuild_queue_depth_ge_2_total');
    }
    if (this.queuedRebuilds >= 4) {
      incPerfCounter('plan_rebuild_queue_depth_ge_4_total');
    }

    const fallbackOutcome = {
      ...createPlanRebuildOutcome(this.deps.getCapacityDryRun()),
      failed: true,
    };
    return this.enqueuePlanOperation(
      async () => {
        const waitMs = Date.now() - enqueuedAt;
        addPerfDuration('plan_rebuild_queue_wait_ms', waitMs);
        if (waitMs > 0) {
          incPerfCounter('plan_rebuild_queue_waited_total');
        }
        if (shouldAbort?.()) {
          onAbort?.();
          incPerfCounter('plan_rebuild_aborted_stale_total');
          return createPlanRebuildOutcome(this.deps.getCapacityDryRun());
        }
        return performPlanRebuild(this.rebuildHost, {
          trigger, detail, queueWaitMs: waitMs, queueDepth,
        });
      },
      'Failed to rebuild plan',
      fallbackOutcome,
      () => {
        this.queuedRebuilds = Math.max(0, this.queuedRebuilds - 1);
      },
    );
  }

  private async enqueuePlanOperation<T>(
    operation: () => Promise<T>,
    errorMessage: string,
    fallbackValue: T,
    onFinally?: () => void,
  ): Promise<T> {
    let result = fallbackValue;
    this.planOperationQueue = this.planOperationQueue
      .then(async () => {
        result = await this.withHomeLogContext(operation);
      })
      .catch((error) => {
        this.withHomeLogContext(() => {
          (this.deps.loggers?.structuredLog ?? logger).error({
            event: 'plan_operation_failed',
            message: errorMessage,
            error: normalizeError(error),
          });
        });
      })
      .finally(() => {
        onFinally?.();
      });

    await this.planOperationQueue;
    return result;
  }

  private withHomeLogContext<T>(operation: () => T): T {
    return runWithContext({ homeId: this.deps.homeId }, operation);
  }

  private updatePlanSnapshot(plan: DevicePlan, changes: PlanChangeSet): void {
    this.tickIdleClassifier(plan);
    const changed = changes.actionChanged || changes.detailChanged || changes.metaChanged;
    if (changed) {
      this.emitPlanUpdated(plan);
      return;
    }
    // No action/detail/meta change, but the overview signature (e.g.
    // measured/expected power, status text) can still move. Capture it; if a
    // transition was recorded, emit `plan_updated` so the open settings-UI
    // activity-log view (which listens for that event) refreshes — otherwise
    // overview-only transitions would record backend-side but never reach the
    // open view.
    this.refreshDeviceStatus(plan);
  }

  // Once per published plan. The capped-idle window's bounded sample history is
  // sized for the plan cadence; observation-driven status refreshes reuse the
  // last classification instead of sampling again.
  private tickIdleClassifier(plan: DevicePlan): void {
    if (this.lastTickedPlanRef === plan) return;
    this.lastTickedPlanRef = plan;
    // The temperature cluster rides as ONE optional object on the classifier
    // input (mirroring the observer's atomic facet): stamped together for a
    // temperature device, omitted otherwise — no nullable fields synthesized.
    // Idle and unresponsive are judged from measured draw, so only a device with
    // a power reading is classified; one without is never called idle.
    const execution = this.deps.planEngine.getDeviceExecutionStates(plan);
    const idleInputs = plan.devices.flatMap((device): IdleClassifierDeviceInput[] => {
      const state = execution.get(device.id);
      if (!state || state.currentDrawKw === undefined) return [];
      const temperature = this.deps.getObservedTemperature(device.id);
      return [{
        id: device.id,
        name: device.name,
        currentState: state.physicalState,
        currentDrawKw: state.currentDrawKw,
        plannedState: device.plannedState,
        ...(temperature.kind === 'observed' ? { temperature: temperature.value } : {}),
      }];
    });
    this.idleClassifier.classifyAll(idleInputs, Date.now());
  }

  private emitPlanUpdated(plan: DevicePlan): void {
    this.tickIdleClassifier(plan);
    const publication = buildOverviewPublication(plan, this.deps, this.idleClassifier);
    if (publication) {
      this.emitOverviewTransitions(publication);
      this.emitPlanUpdatedRealtime(publication.snapshot);
    }
  }

  private emitPlanUpdatedRealtime(snapshot: SettingsUiPlanSnapshot): void {
    // A sub-home capacity bundle (R7b) shares the single settings-UI
    // `plan_updated` channel with the main home; only the main plan drives it.
    // Areas invalidate their scoped read instead of replacing Main's payload.
    const event = this.deps.emitsUiRealtime === false ? PLAN_STATUS_PUBLISHED_EVENT : 'plan_updated';
    const payload = this.deps.emitsUiRealtime === false ? { homeId: this.deps.homeId } : snapshot;
    const api = this.deps.homey.api;
    const realtime = api?.realtime;
    if (typeof realtime === 'function') {
      realtime.call(api, event, payload)
        .catch((err: unknown) => (this.deps.loggers?.structuredLog ?? logger).error({
          event: 'plan_updated_emit_failed',
          realtimeEvent: event,
          error: normalizeError(err),
        }));
    }
  }

  /** Refresh display from live owners while leaving the decision untouched. */
  private refreshDeviceStatus(plan = this.getLatestPlanSnapshot()): boolean {
    if (!plan) return false;
    const publication = buildOverviewPublication(plan, this.deps, this.idleClassifier);
    if (!publication || !this.emitOverviewTransitions(publication)) return false;
    this.emitPlanUpdatedRealtime(publication.snapshot);
    return true;
  }

  // Returns whether presentation changed, independently of logging being enabled.
  private emitOverviewTransitions(publication: OverviewPublication): boolean {
    return this.overviewTransitions.capture(publication.snapshot, this.deps, describeOverviewDecision(publication));
  }

  updatePelsStatus(plan: DevicePlan, changes?: StatusPlanChanges): number {
    return this.planStatusWriter.update(plan, changes);
  }

  private decoratePlanWithPendingTargetCommands(plan: DevicePlan): DevicePlan {
    return this.deps.planEngine.decoratePlanWithPendingTargetCommands(plan);
  }

}

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
 * production (`TODO.md`, inc_26449fb9). Do not reintroduce an apply-without-
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
import { PriceLevel } from '../price/priceLevels';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { normalizeError } from '../utils/errorUtils';
import type { IdleClassification } from '../../packages/shared-domain/src/idleClassificationCopy';
import { buildPlanDetailSignature } from './planLogging';
import { createPlanRebuildOutcome } from './planRebuildMetrics';
import { getLogger } from '../logging/logger';
import { runWithContext } from '../logging/alsContext';
import type {
  SettingsUiDeviceLogPayload,
  SettingsUiPlanSnapshot,
} from '../../packages/contracts/src/settingsUiApi';
import { buildSettingsOverviewReadModel } from './settingsOverviewReadModel';
import { createIdleClassifier, type IdleClassifier, type IdleClassifierDeviceInput } from '../observer/idleClassifier';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import type { PendingBinaryLiveDevice } from '../observer/pendingBinaryCommands';
import { PlanStatusWriter } from './planStatusWriter';
import { buildLiveStatePlan } from './planLiveStateMerge';
import type {
  DevicePlan,
  PendingTargetObservationSource,
  PlanChangeSet,
  PlanRebuildOutcome,
  PlanInputDevice,
  StatusPlanChanges,
} from './planTypes';
import type {
  HeadroomCardDeviceLike,
  HeadroomForDeviceDecision,
  HeadroomUsageObservation,
} from './planHeadroomDevice';
import type { PlanActuationResult } from '../executor/planExecutor';
import { PlanChangeTracker } from './planChangeTracker';
import { emitDeviceOverviewTransitions } from './planOverviewEmit';
import { performPlanRebuild, type PlanRebuildHost } from './planServiceRebuild';
import type { PlanServiceDeps } from './planServiceDeps';

const logger = getLogger('plan/service');

export type { PlanServiceDeps } from './planServiceDeps';

const serializePlanForUi = (
  plan: DevicePlan | null,
  deps: PlanServiceDeps,
  idleClassifier: IdleClassifier,
): SettingsUiPlanSnapshot | null => {
  return buildSettingsOverviewReadModel(plan, {
    getOverviewStarvation: (deviceId) => deps.deviceDiagnostics?.getOverviewStarvation?.(deviceId),
    getIdleClassification: (deviceId) => idleClassifier.getClassification(deviceId),
    getObservedEvChargingState: (deviceId) => deps.getObservedEvChargingState?.(deviceId),
    getAssociatedCarChargingState: (deviceId) => deps.getAssociatedCarChargingState?.(deviceId),
    getObservedTemperature: (deviceId) => deps.getObservedTemperature?.(deviceId),
    getObservationStale: (deviceId) => deps.getObservationStale?.(deviceId) ?? false,
    getDeviceTypeById: deps.getDeviceTypeById,
    getControlModelById: deps.getControlModelById,
  });
};

export class PlanService {
  private latestPlanSnapshot: DevicePlan | null = null;
  private latestPlanSnapshotUpdatedAtMs: number | null = null;
  private lastOverviewSignatureByDeviceId = new Map<string, string>();
  private planOperationQueue: Promise<void> = Promise.resolve();
  private queuedRebuilds = 0;
  private planStatusWriter: PlanStatusWriter;
  private idleClassifier: IdleClassifier;
  private changeTracker: PlanChangeTracker;
  private readonly rebuildHost: PlanRebuildHost;
  private lastTickedPlanRef: DevicePlan | null = null;

  constructor(private deps: PlanServiceDeps) {
    this.idleClassifier = createIdleClassifier({
      structuredLog: deps.loggers?.structuredLog,
      debugStructured: deps.loggers?.debugStructured,
    });
    this.planStatusWriter = new PlanStatusWriter({
      homey: deps.homey,
      writePelsStatus: deps.writePelsStatus,
      getCombinedPrices: deps.getCombinedPrices,
      getCurrentHourPriceLevel: deps.getCurrentHourPriceLevel,
      getLastPowerUpdate: deps.getLastPowerUpdate,
      getEffectiveDryRun: deps.getStatusEffectiveDryRun,
      structuredLog: deps.loggers?.structuredLog,
    });
    this.changeTracker = new PlanChangeTracker({
      debugStructured: deps.loggers?.debugStructured,
      isPlanDebugEnabled: deps.isPlanDebugEnabled,
    });
    this.rebuildHost = {
      deps,
      getLatestPlanSnapshot: () => this.latestPlanSnapshot,
      setLatestPlanSnapshot: (plan) => { this.latestPlanSnapshot = plan; },
      getLatestPlanSnapshotUpdatedAtMs: () => this.latestPlanSnapshotUpdatedAtMs,
      setLatestPlanSnapshotUpdatedAtMs: (ms) => { this.latestPlanSnapshotUpdatedAtMs = ms; },
      settleDevices: () => this.settleDevices(),
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

  // Devices for the binary settle: the observer-internal `binaryControlObservation`
  // evidence lives on the device snapshot, not the plan-facing `PlanInputDevice`, so the
  // settle reads its own source. Falls back to `getPlanDevices` only for tests (see deps).
  private settleDevices(): PendingBinaryLiveDevice[] {
    return (this.deps.getSettleDevices ?? this.deps.getPlanDevices)();
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
  getStallClassification(
    deviceId: string,
  ): IdleClassification | undefined {
    return this.idleClassifier.getClassification(deviceId);
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

  getLastNotifiedPriceLevel(): PriceLevel {
    return this.planStatusWriter.getLastNotifiedPriceLevel();
  }

  getLatestPlanSnapshot(): DevicePlan | null {
    return this.latestPlanSnapshot;
  }

  getLatestPlanSnapshotForUi(): SettingsUiPlanSnapshot | null {
    return serializePlanForUi(this.latestPlanSnapshot, this.deps, this.idleClassifier);
  }

  serializePlanSnapshotForUi(plan: DevicePlan | null): SettingsUiPlanSnapshot | null {
    return serializePlanForUi(plan, this.deps, this.idleClassifier);
  }

  getLatestPlanSnapshotUpdatedAtMs(): number | null {
    return this.latestPlanSnapshotUpdatedAtMs;
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

  async syncLivePlanState(source: PendingTargetObservationSource): Promise<boolean> {
    return this.enqueuePlanOperation(
      () => Promise.resolve(this.syncLivePlanStateInline(source)),
      'Failed to sync live plan state',
      false,
    );
  }

  syncLivePlanStateInline(source: PendingTargetObservationSource): boolean {
    return this.withHomeLogContext(() => this.syncLivePlanStateInlineInContext(source));
  }

  private syncLivePlanStateInlineInContext(source: PendingTargetObservationSource): boolean {
    const hasPendingTargetCommands = this.deps.planEngine.hasPendingTargetCommands();
    const hasPendingBinaryCommands = this.deps.planEngine.hasPendingBinaryCommands();
    if (!hasPendingTargetCommands && !hasPendingBinaryCommands) {
      return false;
    }

    const liveDevices = this.deps.getPlanDevices();
    const pendingTargetChanged = hasPendingTargetCommands
      ? this.deps.planEngine.syncPendingTargetCommands(liveDevices, source)
      : false;
    const pendingBinaryChanged = hasPendingBinaryCommands
      ? this.deps.planEngine.syncPendingBinaryCommands(this.settleDevices(), source)
      : false;
    const pendingChanged = pendingTargetChanged || pendingBinaryChanged;
    if (!this.latestPlanSnapshot) {
      return pendingChanged;
    }

    const livePlan = this.decoratePlanWithPendingTargetCommands(
      buildLiveStatePlan(this.latestPlanSnapshot, liveDevices),
    );
    if (this.deps.planEngine.hasSettledActuation(this.latestPlanSnapshot, livePlan)) {
      const refreshedPlan = this.preservePlanGeneratedAt(livePlan, this.latestPlanSnapshot);
      const nowMs = Date.now();
      this.latestPlanSnapshot = refreshedPlan;
      this.latestPlanSnapshotUpdatedAtMs = nowMs;
      this.emitPlanUpdated(refreshedPlan);
      return true;
    }

    if (!pendingChanged) {
      return false;
    }

    const nextPlan = this.decoratePlanWithPendingTargetCommands(this.latestPlanSnapshot);
    if (buildPlanDetailSignature(nextPlan) === buildPlanDetailSignature(this.latestPlanSnapshot)) {
      return false;
    }
    const refreshedPlan = this.preservePlanGeneratedAt(nextPlan, this.latestPlanSnapshot);
    const nowMs = Date.now();
    this.latestPlanSnapshot = refreshedPlan;
    this.latestPlanSnapshotUpdatedAtMs = nowMs;
    this.emitPlanUpdated(refreshedPlan);
    return true;
  }

  applyPlanActions(plan: DevicePlan): Promise<PlanActuationResult> {
    return this.withHomeLogContext(() => this.deps.planEngine.applyPlanActions(plan));
  }

  applySheddingToDevice(deviceId: string, deviceName: string, reason?: string): Promise<void> {
    return this.enqueuePlanOperation(
      async () => {
        const wrote = await this.deps.planEngine.applySheddingToDevice(deviceId, deviceName, reason);
        if (wrote) {
          this.deps.schedulePostActuationRefresh?.();
        }
      },
      `Failed to apply shedding to ${deviceName}`,
      undefined,
    );
  }

  evaluateHeadroomForDevice(params: {
    devices: HeadroomCardDeviceLike[];
    deviceId: string;
    device?: HeadroomCardDeviceLike;
    headroom: number;
    requiredKw: number;
    cleanupMissingDevices?: boolean;
  }): HeadroomForDeviceDecision | null {
    return this.deps.planEngine.evaluateHeadroomForDevice(params);
  }

  syncHeadroomCardState(params: {
    devices: HeadroomCardDeviceLike[];
    cleanupMissingDevices?: boolean;
    reconciliationContext?: 'snapshot_refresh';
  }): boolean {
    return this.deps.planEngine.syncHeadroomCardState(params);
  }

  syncHeadroomUsageObservation(params: {
    deviceId: string;
    usageObservation: HeadroomUsageObservation;
    reconciliationContext?: 'snapshot_refresh';
  }): boolean {
    return this.deps.planEngine.syncHeadroomUsageObservation(params);
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
    reason = 'unspecified',
    shouldAbort?: () => boolean,
    onAbort?: () => void,
  ): Promise<PlanRebuildOutcome> {
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
        return performPlanRebuild(this.rebuildHost, { reason, queueWaitMs: waitMs, queueDepth });
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
    const captured = this.emitOverviewTransitions(plan);
    if (captured) {
      this.emitPlanUpdatedRealtime(plan);
    }
  }

  private tickIdleClassifier(plan: DevicePlan): void {
    if (this.lastTickedPlanRef === plan) return;
    this.lastTickedPlanRef = plan;
    // Narrow the temperature cluster via the guard so the classifier never reads
    // `currentTarget`/`currentTemperature` off an un-narrowed plan device — a
    // non-temperature device contributes `currentTarget: null` (its old base value).
    // The idle classifier is an observer-side diagnostic tap whose "unresponsive"
    // detection legitimately needs staleness; the plan device no longer carries
    // `observationStale`, so source it from the observer projection here.
    const idleInputs = plan.devices.map((device): IdleClassifierDeviceInput => {
      const observationStale = this.deps.getObservationStale?.(device.id) ?? false;
      const narrowed = isTemperaturePlanDevice(device)
        ? device
        : { ...device, currentTarget: null };
      return { ...narrowed, observationStale };
    });
    this.idleClassifier.classifyAll(idleInputs, Date.now());
  }

  private emitPlanUpdated(plan: DevicePlan): void {
    this.tickIdleClassifier(plan);
    this.emitOverviewTransitions(plan);
    this.emitPlanUpdatedRealtime(plan);
  }

  private emitPlanUpdatedRealtime(plan: DevicePlan): void {
    // A sub-home capacity bundle (R7b) shares the single settings-UI
    // `plan_updated` channel with the main home; only the main plan drives it.
    // Undefined (the pre-R7b default) emits — single-home behavior is unchanged.
    if (this.deps.emitsUiRealtime === false) return;
    const api = this.deps.homey.api;
    const realtime = api?.realtime;
    if (typeof realtime === 'function') {
      realtime.call(api, 'plan_updated', serializePlanForUi(plan, this.deps, this.idleClassifier))
        .catch((err: unknown) => (this.deps.loggers?.structuredLog ?? logger).error({
          event: 'plan_updated_emit_failed',
          error: normalizeError(err),
        }));
    }
  }

  // Returns true when at least one device's overview signature changed (and was
  // captured into the recorder / batched for debug), so the caller can refresh
  // the open settings-UI activity-log view. State (`lastOverviewSignatureByDeviceId`)
  // stays on this class; the emission logic lives in `planOverviewEmit.ts`.
  private emitOverviewTransitions(plan: DevicePlan): boolean {
    return emitDeviceOverviewTransitions(plan, this.lastOverviewSignatureByDeviceId, this.deps);
  }

  updatePelsStatus(plan: DevicePlan, changes?: StatusPlanChanges): number {
    return this.planStatusWriter.update(plan, changes);
  }

  private decoratePlanWithPendingTargetCommands(plan: DevicePlan): DevicePlan {
    return this.deps.planEngine.decoratePlanWithPendingTargetCommands(plan);
  }

}

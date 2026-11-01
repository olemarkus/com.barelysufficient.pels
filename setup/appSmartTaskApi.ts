import type { DeferredObjectiveSettingsKind } from '../packages/contracts/src/deferredObjectiveSettings';
import type { AppContext } from '../lib/app/appContext';
import type { DailyBudgetUiPayload } from '../packages/contracts/src/dailyBudgetTypes';
import type { PlanInputSnapshotDevice } from '../lib/planInput/runtimeDeviceRead';
import type {
  DeferredObjectivePlanPreviewEstimate,
  SmartTaskQuickTargetsRead,
} from '../packages/contracts/src/deferredObjectivePlanPreview';
import type {
  CreateSmartTaskCandidateDevicesRead,
  WidgetObjectiveWriteResult,
} from '../packages/contracts/src/widgetHostApi';
import {
  hasOpenDeferredObjective,
  buildTaskEvaluationSnapshot,
  buildUnavailableDeferredObjectivePlanEstimate,
  readDeferredObjectiveRoster,
  previewDeferredObjectivePlan,
  previewSmartTaskQuickTargetsForDevice,
  type DeferredObjectivePlanPreviewCandidate,
  type DeferredObjectiveSettingsEntry,
  type SmartTaskQuickTargetPreview,
  type TaskEvaluationSource,
} from '../lib/objectives/deferredObjectives';
import {
  cancelDeferredObjectiveForContext,
  toPlanDevice,
} from './appInit';
import type { CancelDeferredObjectiveOutcome } from '../lib/app/pelsHost';
import type { NewSmartTaskWriteResult } from '../packages/contracts/src/smartTaskEdit';
import { requirePlanService } from './appInit/contextGuards';
import {
  requireDeferredObjectiveActivePlanRecorder,
  resolveDeferredObjectiveDeviceWriteDeps,
} from './appInit/deferredRecorders';
import { resolveSmartTaskHomeScope } from './appInit/smartTaskHomeScope';
import { gateCandidateExtraPermissions } from '../lib/objectives/deferredObjectives/limitGrantGate';
import {
  createFreshSmartTask,
  upsertSmartTask,
  type SmartTaskWritePorts,
} from '../lib/objectives/deferredObjectives/smartTaskWrite';
import { createRescueSmartTask } from '../lib/objectives/deferredObjectives/smartTaskRescueCreateLane';
import { isRuntimePlannedDevice } from './appDeviceSupport';
import type { StarvationRescuePlanPreview } from '../packages/contracts/src/starvationRescue';
import { asMeteredSnapshot } from '../lib/ports/meteredSnapshots';

/**
 * Outcome of a smart-task write (create, or the budget-exempt rescue that
 * delegates to it). ALIASED from the widget contract rather than re-declared:
 * `app.ts` carried three inline copies of this union before the extraction, and
 * a copy that drops a reason (or a contract that gains one) still compiles,
 * leaving a widget with a dead reject branch or an unproducible reason.
 */
export type SmartTaskWriteResult = WidgetObjectiveWriteResult;

/**
 * The app's smart-task (deferred-objective) WRITE surface: preview, create,
 * cancel, and the budget-exempt starvation rescue. `PelsApp` keeps thin
 * delegating stubs because both the widget host API (`PelsWidgetHostApi`) and
 * the settings-UI handlers reach these through `homey.app`. The previews are
 * assembled here; the writes bind their ports and forward to
 * `lib/objectives/deferredObjectives/` (`smartTaskWrite.ts`,
 * `smartTaskRescueCreateLane.ts`), which decides them. Read-only payload
 * assembly is the sibling `AppSmartTaskPayloads`.
 *
 * Everything this needs is already on `AppContext` (snapshot reads, clock,
 * price/budget services, the deferred-objective recorders), so the cluster
 * takes the context directly rather than a bespoke dependency bag.
 */
export class AppSmartTaskApi {
  constructor(
    private readonly ctx: AppContext,
    // The main home's evaluation source: the preview reads the household through
    // the same binding as the live lanes.
    private readonly taskEvaluationSource: TaskEvaluationSource,
  ) {}

  // Open-task predicate; semantics documented on the store helper.
  public hasDeferredObjectiveForDevice(deviceId: string): boolean {
    return hasOpenDeferredObjective(this.ctx.homey.settings, deviceId, this.ctx.getNow().getTime());
  }

  // `AppContext` types `priceCoordinator` as optional (the boot window), but a
  // preview must never quote a money total with a silently-missing rate label.
  // Asserting instead of optional-chaining keeps that guarantee in the type
  // system rather than in this object literal's property order: the
  // `priceOptimizationEnabled` read is backed by the same coordinator and would
  // throw first today, but reordering the literal must not change the outcome.
  private requirePriceRateLabel(): string {
    const coordinator = this.ctx.priceCoordinator;
    if (!coordinator) {
      throw new Error('PriceCoordinator must be initialized before previewing a smart task.');
    }
    return coordinator.getPriceUnitLabel();
  }

  // Same boot-window contract as `requirePriceRateLabel`, and needed for a
  // sharper reason: `getSnapshot()` legitimately returns `null` (no budget
  // computed yet / budget off), so the `?.` + `?? null` this body inherited
  // verbatim from `app.ts` would make "no budget" and "service not wired yet"
  // indistinguishable — a preview quoting an estimate that silently ignores a
  // configured daily budget. The chain was vestigial in `app.ts` (the field is
  // declared definite there) and load-bearing here (`AppContext` types the
  // member optional), which is exactly the nullability a moved body inherits.
  private requireDailyBudgetSnapshot(): DailyBudgetUiPayload | null {
    return this.requireDailyBudgetService().getSnapshot();
  }

  private requireDailyBudgetService(): NonNullable<AppContext['dailyBudgetService']> {
    const service = this.ctx.dailyBudgetService;
    if (!service) {
      throw new Error('DailyBudgetService must be initialized before previewing a smart task.');
    }
    return service;
  }



  // Preview the plan the starvation rescue would actually persist. A rescue only
  // ever runs on a device WITHOUT an existing smart task (`getStarvedRescueDevices`
  // excludes task-having devices), so there is no merge: the fresh candidate IS
  // what persists. This therefore just REUSES the create engine's preview
  // (`previewDeferredObjectivePlan`), which applies the same
  // `gateCandidateExtraPermissions` the create write does — so preview ≡ persist
  // for the rescue's opt-in permissions without any rescue-specific merge logic.
  // `hasExistingObjective` is always false (kept on the return for the widget's
  // stable shape).
  public previewStarvationRescuePlan(
    deviceId: string,
    freshRescueCandidate: DeferredObjectivePlanPreviewCandidate,
  ): StarvationRescuePlanPreview {
    return {
      estimate: this.previewDeferredObjectivePlan(deviceId, freshRescueCandidate),
      deadlineAtMs: freshRescueCandidate.deadlineAtMs,
      hasExistingObjective: false,
      dailyBudgetEnabled: this.requireDailyBudgetService().isEnabled(),
    };
  }

  // Instant, priority-coordinated estimate of the plan the planner WOULD produce for a
  // candidate deferred objective that is not persisted. Gathers the same plan-
  // cycle context the live recorder runs against (device snapshot, power
  // tracker, daily-budget snapshot, hard cap, prices) so the projection stays
  // faithful — see `previewDeferredObjectivePlan`.
  //
  // STRICTLY READ-ONLY: this never mutates live planner state. The candidate
  // device is projected through `toPlanDevice`, a pure read projection with no
  // live-state mutation.
  //
  // NOT A GUARANTEE: the projection includes the current smart-task roster and
  // settled higher-priority commitments, but it does not reserve or mutate the
  // live plan. A UI must present it as an estimate.
  public previewDeferredObjectivePlan(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): DeferredObjectivePlanPreviewEstimate {
    const session = this.openPreviewSession(deviceId);
    if (session.state === 'unavailable') return buildUnavailableDeferredObjectivePlanEstimate('settings_unavailable');
    // Gate opt-in extra permissions the same way the create lane does, so the
    // preview reflects exactly what would persist (preview ≡ persist).
    return session.preview(gateCandidateExtraPermissions(session.device, candidate, {
      entry: session.storedEntry,
      absenceTrustworthy: true,
    }));
  }

  // The quick targets a creation surface offers for a `kind` task on `deviceId`
  // among `candidates`, each timed against the same preview as
  // `previewDeferredObjectivePlan`. One session serves every probe, so the
  // household is read once. Quick targets carry no extra permissions, so there
  // is nothing to gate.
  public previewSmartTaskQuickTargets(
    deviceId: string,
    kind: DeferredObjectiveSettingsKind,
    candidates: CreateSmartTaskCandidateDevicesRead,
  ): SmartTaskQuickTargetsRead {
    const session = this.openPreviewSession(deviceId);
    if (session.state === 'unavailable') return { state: 'unavailable', reason: 'settings_unavailable' };
    return previewSmartTaskQuickTargetsForDevice(
      candidates, deviceId, kind, session.preview, this.ctx.getNow().getTime(),
    );
  }

  // One household read for any number of candidate previews on `deviceId`.
  private openPreviewSession(deviceId: string): {
    state: 'ready';
    device: PlanInputSnapshotDevice | undefined;
    storedEntry: DeferredObjectiveSettingsEntry | undefined;
    preview: SmartTaskQuickTargetPreview;
  } | { state: 'unavailable' } {
    // Preserve every boot-window invariant before classifying a transient
    // settings read. Missing services are wiring errors, not an empty plan.
    const dailyBudgetSnapshot = this.requireDailyBudgetSnapshot();
    const priceRateLabel = this.requirePriceRateLabel();
    const planService = requirePlanService(this.ctx);
    requireDeferredObjectiveActivePlanRecorder(this.ctx);
    const roster = readDeferredObjectiveRoster(this.ctx.homey.settings);
    if (roster.status === 'unavailable') return { state: 'unavailable' };
    // Preview uses the same configuration + Observer inputs as runtime planning.
    const snapshotDevice = this.ctx.getPlanInputSnapshot().find((device) => device.id === deviceId);
    const planDevices = planService.getPlanDevices();
    const meteredSnapshotDevice = snapshotDevice && asMeteredSnapshot(snapshotDevice);
    const candidateDevice = meteredSnapshotDevice
      ? toPlanDevice(this.ctx, meteredSnapshotDevice)
      : undefined;
    const previewDevices = candidateDevice && !planDevices.some((device) => device.id === candidateDevice.id)
      ? [...planDevices, candidateDevice]
      : planDevices;
    const previewPriorities = this.taskEvaluationSource.getPrioritiesForDevices(
      previewDevices.map((device) => device.id),
    );
    const devices = previewDevices.map((device) => ({
      ...device,
      priority: previewPriorities.getPriority(device.id),
    }));
    // Converted through the same metered producer the plan cycle uses so the
    // projected steps/power match the live planner. The projection is a pure
    // read projection (no live-state mutation), so the preview is read-only by
    // construction. A candidate device in neither snapshot is absent here →
    // projection comes back `unavailable`.
    const snapshot = buildTaskEvaluationSnapshot(
      this.taskEvaluationSource, this.ctx.getNow().getTime(), devices, roster.settings, dailyBudgetSnapshot,
    );
    // The price store exposes a per-kWh RATE label; `previewDeferredObjectivePlan`
    // converts it to a money unit for the total `costEstimate`.
    return {
      state: 'ready',
      device: snapshotDevice,
      storedEntry: roster.settings.objectivesByDeviceId[deviceId],
      preview: (candidate) => previewDeferredObjectivePlan(
        snapshot, this.taskEvaluationSource, deviceId, candidate, priceRateLabel,
      ),
    };
  }

  // The ports every smart-task write runs on, decided in
  // `lib/objectives/deferredObjectives/smartTaskWrite.ts`: the runtime plan
  // input, the planner's planned-set rule, the picker, the Main-home scope, the
  // stored tasks, and the device-scoped write op's deps.
  private writePorts(): SmartTaskWritePorts<PlanInputSnapshotDevice> {
    const nowMs = this.ctx.getNow().getTime();
    return {
      reads: {
        findPlanInputDevice: (deviceId) => this.ctx.getPlanInputSnapshot().find((entry) => entry.id === deviceId),
        isRuntimePlanned: isRuntimePlannedDevice,
        isPickerDevice: (deviceId) => this.ctx.getUiPickerDevices().some((entry) => entry.id === deviceId),
        resolveHomeScope: (deviceId) => resolveSmartTaskHomeScope(this.ctx, deviceId),
        store: this.ctx.homey.settings,
      },
      resolveWriteDeps: () => resolveDeferredObjectiveDeviceWriteDeps(this.ctx, nowMs),
      nowMs,
    };
  }

  // The widget create and the settings UI's edit (`upsertSmartTask`).
  // `rescuePolicy` is REQUIRED here on purpose: the app stub already defaults
  // it, and a second default on this body could drift from that one.
  public createDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
    rescuePolicy: 'preserve' | 'replace',
  ): SmartTaskWriteResult {
    return upsertSmartTask(this.writePorts(), deviceId, candidate, rescuePolicy);
  }

  // The settings UI's create (`createFreshSmartTask`).
  public createNewDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): NewSmartTaskWriteResult {
    return createFreshSmartTask(this.writePorts(), deviceId, candidate);
  }

  public cancelDeferredObjective(deviceId: string): CancelDeferredObjectiveOutcome {
    return cancelDeferredObjectiveForContext(this.ctx, deviceId);
  }

  // The starvation rescue's budget-exempt create (`createRescueSmartTask`).
  public rescueDeviceWithBudgetExemption(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): SmartTaskWriteResult {
    return createRescueSmartTask(this.writePorts(), deviceId, candidate);
  }
}

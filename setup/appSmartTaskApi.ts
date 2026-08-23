import type { AppContext } from '../lib/app/appContext';
import type { DailyBudgetUiPayload } from '../packages/contracts/src/dailyBudgetTypes';
import type {
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
import type { DeferredObjectivePlanPreviewEstimate } from '../packages/contracts/src/deferredObjectivePlanPreview';
import type { WidgetObjectiveWriteResult } from '../packages/contracts/src/widgetHostApi';
import {
  resolveSmartTaskDeviceKind,
  resolveSmartTaskGoalBounds,
} from '../packages/shared-domain/src/smartTaskDeviceKind';
import { rankActiveDevicePriorities } from '../packages/shared-domain/src/modePriorities';
import { isSteppedLoadSnapshot } from '../packages/shared-domain/src/steppedLoadObservedState';
import {
  hasOpenDeferredObjective,
  buildUnavailableDeferredObjectivePlanEstimate,
  migrateBlobToPerKeyIfNeeded,
  readDeferredObjectiveRoster,
  normalizeDeferredObjectiveSettingsEntry,
  previewDeferredObjectivePlan,
  readObjectiveForDevice,
  upsertObjectiveForDevice,
  type DeferredObjectivePlanPreviewCandidate,
  type DeferredObjectiveRescueMode,
  type DeferredObjectiveSettingsEntry,
  type SmartTaskWriteOrigin,
} from '../lib/objectives/deferredObjectives';
import {
  buildDeferredObjectiveDeviceWriteDeps,
  cancelDeferredObjectiveForContext,
  toPlanDevice,
  type CancelDeferredObjectiveOutcome,
} from './appInit';
import { createObjectivePriceHorizonBuilder } from './appInit/objectivePriceHorizon';
import { requirePlanService } from './appInit/contextGuards';
import {
  resolveSmartTaskDeviceExclusion,
  mapObjectiveWriteRefusalReason,
  resolveSmartTaskHomeScope,
} from './appInit/smartTaskHomeScope';
import { objectiveAbsenceIsTrustworthy } from '../lib/objectives/deferredObjectives/objectiveStore';
import { isRuntimePlannedDevice } from './appDeviceSupport';
import { getLogger } from '../lib/logging/logger';
import { resolveConfiguredDevicePriority } from '../lib/utils/capacityHelpers';

const logger = getLogger('setup/smart-task-api');

/**
 * Outcome of a smart-task write (create, or the budget-exempt rescue that
 * delegates to it). ALIASED from the widget contract rather than re-declared:
 * `app.ts` carried three inline copies of this union before the extraction, and
 * a copy that drops a reason (or a contract that gains one) still compiles,
 * leaving a widget with a dead reject branch or an unproducible reason.
 */
export type SmartTaskWriteResult = WidgetObjectiveWriteResult;

/**
 * Durable scope reasons stay typed; transient refusals collapse to the
 * retryable `write_refused`. Deliberately NOT exported: the settings-UI edit
 * lane has its own differently-shaped `SmartTaskWriteRejectReason` in
 * `packages/contracts/src/smartTaskEdit.ts`, and two same-named unions reachable
 * from `setup/**` is an auto-import trap.
 */
type SmartTaskWriteRejectReason = Extract<WidgetObjectiveWriteResult, { ok: false }>['reason'];

type StoredObjectiveState = {
  entry: DeferredObjectiveSettingsEntry | undefined;
  absenceTrustworthy: boolean;
};

/**
 * Rebuild-reason tag for a write that did not name its own lane: the widget
 * create surface and the budget-exempt rescue (which delegates to the create
 * engine). ONE literal, referenced by the `app.ts` stub's default and by the
 * rescue lane, so the two can never drift apart.
 */
export const SMART_TASK_WIDGET_WRITE_ORIGIN: SmartTaskWriteOrigin = 'flow_card:create_smart_task_widget';

/**
 * The app's smart-task (deferred-objective) WRITE surface: preview, create,
 * cancel, and the budget-exempt starvation rescue. `PelsApp` keeps thin
 * delegating stubs because both the widget host API (`PelsWidgetHostApi`) and
 * the settings-UI handlers reach these through `homey.app`; the bodies (and the
 * gating rationale) live here. Read-only payload assembly is the sibling
 * `AppSmartTaskPayloads`.
 *
 * Everything this needs is already on `AppContext` (snapshot reads, clock,
 * price/budget services, the deferred-objective recorders), so the cluster
 * takes the context directly rather than a bespoke dependency bag.
 */
export class AppSmartTaskApi {
  constructor(private readonly ctx: AppContext) {}

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
    const service = this.ctx.dailyBudgetService;
    if (!service) {
      throw new Error('DailyBudgetService must be initialized before previewing a smart task.');
    }
    return service.getSnapshot();
  }

  private requireActivePlanRecorder(): NonNullable<AppContext['deferredObjectiveActivePlanRecorder']> {
    const recorder = this.ctx.deferredObjectiveActivePlanRecorder;
    if (!recorder) {
      throw new Error('DeferredObjectiveActivePlanRecorder must be initialized before previewing a smart task.');
    }
    return recorder;
  }

  // Only stepped-load devices (EV chargers + stepped thermal) can honour the
  // `limitLowerPriorityDevices` rescue permission — it engages the device's boost,
  // which the boost resolvers gate on `isSteppedLoad`; a binary on/off device has
  // no higher step to promote to. The rescue gates the grant on this so it never
  // persists (nor surfaces) a permission the device can't use.
  private deviceSupportsLimitLowerPriority(device: TargetDeviceSnapshot & SteppedLoadDescriptorProbe): boolean {
    return device.controlModel === 'stepped_load' && isSteppedLoadSnapshot(device);
  }

  // Which conjunct of the limit-lower-priority gate failed, for the withheld-grant
  // log below. Only reached when the grant was requested and dropped.
  private resolveLimitWithheldReason(
    device: (TargetDeviceSnapshot & SteppedLoadDescriptorProbe) | undefined,
  ): 'device_unknown' | 'not_stepped_load' | 'budget_exemption_absent' {
    if (device === undefined) return 'device_unknown';
    if (!this.deviceSupportsLimitLowerPriority(device)) return 'not_stepped_load';
    return 'budget_exemption_absent';
  }

  // A grant we can't rule out counts as established: an unreadable store is
  // the same class of transient as a half-warmed device snapshot, so treating
  // its silence as "nothing stands" would reintroduce the revocation this
  // check exists to stop (`objectiveAbsenceIsTrustworthy` is the same guard
  // the write ops use before acting on an absence). An established grant
  // survives every request except the one that revokes the stored `'always'`
  // exemption it was paired with at grant time (e2e-pinned). A standing grant
  // with NO stored pairing — the Flow card writes limit-only verbatim, and the
  // runtime honours it — has no pairing to revoke, so it survives a goal-only
  // edit that names all three permissions.
  private establishedLimitGrantSurvives(
    storedState: StoredObjectiveState,
    requestedExemptFromBudget: DeferredObjectiveRescueMode | undefined,
  ): boolean {
    const stored = storedState.entry;
    const standsOrUnknown = stored === undefined
      ? !storedState.absenceTrustworthy
      : stored.rescue?.limitLowerPriorityDevices !== undefined;
    if (!standsOrUnknown) return false;
    const revokesStoredPairing = stored?.rescue?.exemptFromBudget === 'always'
      && requestedExemptFromBudget !== 'always';
    return !revokesStoredPairing;
  }

  // Gate a create-smart-task candidate's opt-in "Extra permissions" against the
  // device BEFORE it is previewed or persisted — defence-in-depth, since the
  // widget's toggle visibility is client-side and not trusted. Only
  // `limitLowerPriorityDevices` is gated; `exemptFromBudget` and
  // `pauseLowerPriorityDevices` are ungated (any device can exceed the soft daily
  // budget, and the startup reservation is priority-relative by construction).
  // A NEW limit grant is dropped when the device is not stepped-load eligible
  // (a binary device has no higher step to promote to, and the boost resolvers
  // gate on `hasSteppedLoadProfile`), or when `exemptFromBudget` is not granted
  // as `'always'` — the pairing every PELS-owned grant surface requires. The
  // pairing is a contract rule for new grants, NOT an inertness fact: the Flow
  // card writes limit-only grants verbatim (it is the authority on rescue), and
  // the runtime honours them — `limitLowerPriorityApplied` keys on the grant
  // alone (`lib/objectives/deferredObjectives/freshDiagnostic.ts`).
  //
  // NOT gated on `priority === 1`. That conjunct belongs to the planner's
  // `fullyReserved` FLOOR PROMOTION (`rescueReplan.ts`), where it is load-bearing
  // because the reserved-headroom forecast (`hardCap − uncontrolled`) assumes
  // every controlled watt is displaceable — true only at the top. Persisting the
  // permission is a different question: limiting lower-priority devices helps at
  // any priority, because the two paths that actually take load off another
  // device both compare priority STRICTLY, against the same priority source
  // (`lib/plan/planDevices.ts`):
  //   - swap selection — `lib/plan/swap/candidates.ts` refuses any candidate with
  //     `onDevPriority <= devPriority`;
  //   - startup-reserve admission — `lib/plan/admission/headroomReserve.ts` only
  //     withholds power from devices with `reserve.priority < devPriority`.
  // So a boosted priority-2 device can never command a priority-1 device or a
  // peer off. (Narrower than "the planner is priority-safe": the boost bypasses
  // in `lib/plan/restore/steppedRestoreAdmission.ts` and `planSteppedLoad.ts` are
  // priority-BLIND, so a boosted low-priority device can out-compete a shed
  // higher-priority one for headroom. That is pre-existing and equally reachable
  // via any user-configured device boost — but do not read this comment as
  // claiming otherwise.)
  //
  // Copying the floor's conjuncts here silently withheld the permission from
  // every non-top device — while the `allow_smart_task_rescue` Flow card, which
  // bypasses this gate, granted it on the same devices.
  //
  // Runs on BOTH lanes so preview ≡ persist. Returns the candidate unchanged when
  // it carries no limit-lower-priority grant.
  //
  // The gate WITHHOLDS a grant the caller is newly asking for; it must never
  // ERASE one the device already holds. The distinction is load-bearing now that
  // the settings-UI edit lane writes with `rescue: 'replace'`: the eligibility
  // test reads `controlModel`, which is re-derived from live device reads
  // (`lib/device/managerNativeEv.ts`) and is absent for an auto-native-wired
  // stepper during the post-restart window while `autoNativeWiringDecisions` —
  // in-memory, populated by a background pass — is still filling in. Without the
  // standing check, one degraded read during an unrelated goal edit would
  // permanently revoke an effective permission: the destructive-reset-on-a-
  // transient-read pattern `notes/persisted-settings-state.md` exists to prevent.
  //
  // Preview threads in the entry from its already-trusted whole-roster read;
  // write lanes resolve the same classified state locally. That keeps a thrown
  // preview read on the explicit settings-unavailable path.
  //
  // For an ESTABLISHED grant, the budget-exemption conjunct is enforced only as
  // a revocation TRANSITION: a stored `'always'` pairing revoked by this request
  // still strips the limit grant (e2e-pinned — revoking the exemption while
  // keeping the limit toggle must not persist the pair-gated `{ limit }` this
  // surface promises). A standing grant with NO stored pairing — the Flow card
  // writes limit-only verbatim, and the runtime honours it — must survive: the
  // editor names all three permissions on every save, so re-requiring the
  // pairing here made any goal-only edit silently revoke a working grant.
  private gateCandidateExtraPermissions(
    deviceId: string,
    device: (TargetDeviceSnapshot & SteppedLoadDescriptorProbe) | undefined,
    candidate: DeferredObjectivePlanPreviewCandidate,
    storedState?: StoredObjectiveState,
  ): DeferredObjectivePlanPreviewCandidate {
    const rescue = candidate.rescue;
    if (!rescue?.limitLowerPriorityDevices) return candidate;
    const existing = storedState ?? this.readStoredObjectiveState(deviceId);
    if (this.establishedLimitGrantSurvives(existing, rescue.exemptFromBudget)) return candidate;
    const eligible = device !== undefined
      && this.deviceSupportsLimitLowerPriority(device)
      && rescue.exemptFromBudget === 'always';
    if (eligible) return candidate;
    // A withheld grant is otherwise invisible: the write succeeds, the task looks
    // created, and the device simply never gets the priority it was promised.
    // Name the failing conjunct so a log review can tell "binary device" from
    // "no budget exemption to pair with" without re-deriving the gate.
    //
    // `debug`, not `info`: the rescue requests the grant for EVERY device, so on
    // the binary devices that dominate the starved set this is the normal path,
    // and it fires on both the preview and the persist lane (twice per tap).
    logger.debug({
      event: 'smart_task_permission_withheld',
      permission: 'limitLowerPriorityDevices',
      reason: this.resolveLimitWithheldReason(device),
      deviceId: device?.id ?? null,
      deviceName: device?.name ?? null,
    });
    const { limitLowerPriorityDevices: _dropped, ...keptRescue } = rescue;
    return {
      ...candidate,
      rescue: Object.keys(keptRescue).length > 0 ? keptRescue : undefined,
    };
  }

  private readStoredObjectiveState(deviceId: string): StoredObjectiveState {
    try {
      const entry = readObjectiveForDevice(this.ctx.homey.settings, deviceId);
      return {
        entry,
        absenceTrustworthy: entry !== undefined
          || objectiveAbsenceIsTrustworthy(this.ctx.homey.settings, deviceId),
      };
    } catch {
      return { entry: undefined, absenceTrustworthy: false };
    }
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
  ): { estimate: DeferredObjectivePlanPreviewEstimate; deadlineAtMs: number; hasExistingObjective: boolean } {
    return {
      estimate: this.previewDeferredObjectivePlan(deviceId, freshRescueCandidate),
      deadlineAtMs: freshRescueCandidate.deadlineAtMs,
      hasExistingObjective: false,
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
    // Preserve every boot-window invariant before classifying a transient
    // settings read. Missing services are wiring errors, not an empty plan.
    const dailyBudgetSnapshot = this.requireDailyBudgetSnapshot();
    const priceRateLabel = this.requirePriceRateLabel();
    const planService = requirePlanService(this.ctx);
    const activePlanRecorder = this.requireActivePlanRecorder();
    const roster = readDeferredObjectiveRoster(this.ctx.homey.settings);
    if (roster.status === 'unavailable') {
      return buildUnavailableDeferredObjectivePlanEstimate({
        reason: 'settings_unavailable',
        candidate,
        includeGrantedRescuePermissions: false,
      });
    }
    // The settings-UI device list spans managed devices AND unmanaged-but-
    // eligible picker devices (see `getSettingsUiDevices`). A preview is most
    // useful precisely for a candidate that is not managed yet, so fall back to
    // the picker snapshot before treating the device as missing — otherwise
    // every new-smart-task preview would come back `unavailable`.
    const snapshotDevice = this.ctx.latestTargetSnapshot.find((device) => device.id === deviceId)
      ?? this.ctx.getUiPickerDevices().find((device) => device.id === deviceId);
    // Gate opt-in extra permissions the same way the create lane does, so the
    // preview reflects exactly what would persist (preview ≡ persist).
    const gatedCandidate = this.gateCandidateExtraPermissions(deviceId, snapshotDevice, candidate, {
      entry: roster.settings.objectivesByDeviceId[deviceId],
      absenceTrustworthy: true,
    });
    const planDevices = planService.getPlanDevices();
    const candidateDevice = snapshotDevice ? toPlanDevice(this.ctx, snapshotDevice) : undefined;
    const previewDevices = candidateDevice && !planDevices.some((device) => device.id === candidateDevice.id)
      ? [...planDevices, candidateDevice]
      : planDevices;
    const previewPriorityByDeviceId = rankActiveDevicePriorities(
      previewDevices.map((device) => device.id),
      (id) => resolveConfiguredDevicePriority(
        this.ctx.capacityPriorities,
        this.ctx.operatingMode,
        id,
      ),
    );
    const devices = previewDevices.map((device) => ({
      ...device,
      priority: previewPriorityByDeviceId[device.id],
    }));
    const previewDevice = devices.find((device) => device.id === deviceId);
    return previewDeferredObjectivePlan({
      nowMs: this.ctx.getNow().getTime(),
      timeZone: this.ctx.getTimeZone(),
      deviceId,
      candidate: gatedCandidate,
      // Convert through the same `toPlanDevice` producer the plan cycle uses so
      // the projected steps/power match the live planner. `toPlanDevice` is a
      // pure read projection (no live-state mutation), so the preview is
      // read-only by construction. Undefined when the device is in neither
      // snapshot → projection comes back `unavailable`.
      device: previewDevice,
      devices,
      settings: roster.settings,
      activePlans: activePlanRecorder.getActivePlansSnapshot(),
      getBasePriorityForDevice: (id) => resolveConfiguredDevicePriority(
        this.ctx.capacityPriorities,
        this.ctx.operatingMode,
        id,
      ),
      resolveDeviceExclusion: (id) => resolveSmartTaskDeviceExclusion(this.ctx, id),
      powerTracker: this.ctx.powerTracker,
      dailyBudgetSnapshot,
      buildPriceHorizon: createObjectivePriceHorizonBuilder(this.ctx),
      priceOptimizationEnabled: this.ctx.priceOptimizationEnabled,
      hardCapKw: this.ctx.capacitySettings.limitKw,
      // The price store exposes a per-kWh RATE label; `previewDeferredObjectivePlan`
      // converts it to a money unit for the total `costEstimate`.
      priceRateLabel,
    });
  }

  // Shared validation for both objective-write lanes (`createDeferredObjective`
  // and `rescueDeviceWithBudgetExemption`): resolve the candidate against the
  // runtime-planned snapshot, the device's goal kind, and the device's actual
  // setpoint range, then normalise it through the canonical normalizer. Returns
  // the validated device + normalised entry, or a stable rejection reason. Both
  // callers share this so the device honesty / kind / bounds / normalizer gates
  // never diverge between the two lanes.
  private resolveValidatedObjectiveEntry(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): { ok: true; device: TargetDeviceSnapshot; entry: DeferredObjectiveSettingsEntry } | {
    ok: false;
    reason: SmartTaskWriteRejectReason;
  } {
    // Persist ONLY against the runtime-planned snapshot — see PLANNED-SET
    // HONESTY above. A device that exists in the picker but not here, OR that is
    // in the runtime snapshot but `managed: false` (so the planner's
    // `isRuntimePlannedDevice` filter drops it — possible when the managed
    // filter is inactive), is reported as `device_not_planned`, not silently
    // persisted. Uses the SAME predicate the plan service and the candidate
    // listing use so the three never diverge.
    const device = this.ctx.latestTargetSnapshot.find((entry) => entry.id === deviceId);
    if (!device || !isRuntimePlannedDevice(device)) {
      const inPickerOrSnapshot = device !== undefined
        || this.ctx.getUiPickerDevices().some((entry) => entry.id === deviceId);
      return { ok: false, reason: inPickerOrSnapshot ? 'device_not_planned' : 'device_not_found' };
    }
    // Multi-home v1 scope: a sub-home device is rejected with its own honest
    // reason BEFORE kind/bounds validation — the admission math is main-only,
    // so the task would be planned against the wrong meter's budget. Mirrors
    // the candidate-list exclusion and the write-op gate so the three can
    // never disagree.
    const homeScope = resolveSmartTaskHomeScope(this.ctx, deviceId);
    if (homeScope === 'sub_home') return { ok: false, reason: 'device_in_sub_home' };
    if (homeScope === 'source_device') return { ok: false, reason: 'device_not_planned' };
    if (homeScope === 'unavailable') return { ok: false, reason: 'write_refused' };
    // The device must support the goal kind the candidate claims — an EV-SoC
    // goal on a thermostat (or vice versa) is rejected before it can persist.
    const kind = resolveSmartTaskDeviceKind(device);
    if (kind !== candidate.kind) {
      return { ok: false, reason: 'device_not_eligible' };
    }
    // Validate the target against the DEVICE's actual setpoint range, not just
    // the generic normalizer's -50..100 °C / 1..100 % envelope. This mirrors the
    // Flow-card `validateTargetTemperature` (which reads the device capability
    // min/max) and the picker bounds the widget itself offered, so the write
    // rejects an impossible target (e.g. 90 °C on a 30..75 °C heater) instead of
    // persisting one the device can never reach.
    const bounds = resolveSmartTaskGoalBounds(device, kind);
    const targetValue = candidate.kind === 'temperature' ? candidate.targetTemperatureC : candidate.targetPercent;
    if (!Number.isFinite(targetValue) || targetValue < bounds.min || targetValue > bounds.max) {
      return { ok: false, reason: 'invalid_candidate' };
    }
    // Gate opt-in extra permissions against the resolved device before the entry
    // is normalised/persisted (drops an ineligible/inert limit-lower-priority
    // grant), so a tampered or stale client can never persist a permission this
    // device can't honour. Matches the gate the preview applies.
    const gatedCandidate = this.gateCandidateExtraPermissions(deviceId, device, candidate);
    // Re-validate via the canonical normalizer with `enabled: true`; a creation
    // is implicitly an enabled objective. This rejects malformed deadlines and
    // the generic target envelope exactly as the Flow-card / settings paths do.
    const entry = normalizeDeferredObjectiveSettingsEntry(
      { ...gatedCandidate, enabled: true } as DeferredObjectiveSettingsEntry,
    );
    if (!entry) return { ok: false, reason: 'invalid_candidate' };
    return { ok: true, device, entry };
  }

  // Persist a new smart task (deferred objective) for an eligible device,
  // routing through the SAME device-scoped write op the deadline Flow cards use
  // (`upsertObjectiveForDevice` over the per-device-key store, built by
  // `buildDeferredObjectiveDeviceWriteDeps`). There is no parallel
  // persistence path: the candidate is validated through the same
  // `normalizeDeferredObjectiveSettingsEntry` normalizer that gates Flow-card
  // and settings writes, and the device's eligibility/kind is checked against
  // the live snapshot the same way the Flow cards check it.
  //
  // PLANNED-SET HONESTY: persistence is restricted to devices in
  // `latestTargetSnapshot` — the managed, runtime-planned set. The planner only
  // evaluates objectives whose device is in that snapshot (see
  // `buildDeferredObjectiveDiagnostics`: a missing device yields
  // `objective_missing_device` and is never planned). When the managed-device
  // filter is active, a picker-only (unmanaged) device is absent from the
  // snapshot, so creating a task on it would persist a task that never plans or
  // controls anything. The Flow-card create path is already honest here — its
  // device autocomplete is sourced from the same runtime snapshot — so to match
  // it we reject picker-only devices with `device_not_planned` rather than
  // inventing a promotion mechanism neither path has. (The preview at
  // `previewDeferredObjectivePlan` keeps its picker fallback: previewing an
  // unmanaged device is harmless and read-only.)
  //
  // The candidate's `deadlineAtMs` is resolved by the caller (the widget API
  // handler, server-side, via `resolveDeferredObjectiveDeadline` against the
  // app timezone) so this method stays timezone-agnostic and matches the
  // Flow-card contract of receiving an already-absolute deadline.
  //
  // Returns `{ ok: false }` with a stable reason code on rejection so the
  // widget can surface an honest error without leaking internal detail.
  //
  // `origin` (the requesting lane's rebuild-reason tag) is REQUIRED here on
  // purpose: a second default on this body could drift from the app stub's.
  // Callers with no lane of their own pass `SMART_TASK_WIDGET_WRITE_ORIGIN`.
  //
  // `rescuePolicy` is REQUIRED here for the same reason `origin` is: the app
  // stub already defaults it, and a second default on this body could drift
  // from that one. `'preserve'` is the additive lane, where a candidate that
  // names no permissions leaves a standing grant alone; the settings-UI edit
  // lane passes `'replace'` because its request states the COMPLETE desired
  // set, so an unchecked toggle must actually revoke.
  public createDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
    origin: SmartTaskWriteOrigin,
    rescuePolicy: 'preserve' | 'replace',
  ): SmartTaskWriteResult {
    const validated = this.resolveValidatedObjectiveEntry(deviceId, candidate);
    if (!validated.ok) return validated;
    const { device, entry } = validated;

    if (!this.ctx.deferredObjectivePlanHistoryRecorder || !this.ctx.deferredObjectiveActivePlanRecorder) {
      return { ok: false, reason: 'invalid_candidate' };
    }

    // Per-device-key write: touches only this device's settings key, so it
    // cannot drop a sibling task. When the candidate carries opt-in "Extra
    // permissions" (already eligibility-gated above), the entry's own `rescue` is
    // persisted as-is. When it does not, the default `preserve` policy keeps a
    // standing permission set elsewhere (e.g. by the budget-exempt rescue lane,
    // `rescueDeviceWithBudgetExemption`) intact rather than wiping it. The write
    // can still REFUSE on a transient un-confirmable migration or an untrustworthy
    // absence read; surface that as a retryable failure instead of a false
    // success so the widget can re-offer the create.
    const outcome = upsertObjectiveForDevice(
      buildDeferredObjectiveDeviceWriteDeps(this.ctx, {
        nowMs: this.ctx.getNow().getTime(),
        rebuildReason: origin,
      }),
      { deviceId, deviceName: device.name ?? null, entry, rescue: rescuePolicy },
    );
    // Refusal → reject union mapping (durable scope reasons stay typed; the
    // transient refusals collapse to the retryable `write_refused` lane).
    if (!outcome.persisted) return { ok: false, reason: mapObjectiveWriteRefusalReason(outcome.reason) };
    return { ok: true };
  }

  public cancelDeferredObjective(deviceId: string): CancelDeferredObjectiveOutcome {
    return cancelDeferredObjectiveForContext(this.ctx, deviceId);
  }

  // Grant a device the starvation-rescue widget's bounded budget-exempt rescue.
  // A rescue is always a FRESH task: `getStarvedRescueDevices` only offers a
  // device that has no smart task yet (and this method re-asserts it), so there
  // is no merge — the rescue REUSES the create engine (`createDeferredObjective`).
  // The candidate carries ALL THREE extra permissions (`buildRescueCandidate`):
  // `exemptFromBudget`, `limitLowerPriorityDevices` and `pauseLowerPriorityDevices`.
  // `createDeferredObjective`'s `gateCandidateExtraPermissions` keeps the budget
  // exemption and the startup reservation for any device — both are ungated — and
  // the limit-lower-priority grant wherever it has effect (stepped-load, paired
  // with the exemption; NOT gated on priority). So a rescue can persist any
  // subset, and the surfaces derive what they show from the preview's
  // `grantedRescuePermissions` rather than from the request.
  //
  // This lifts the DAILY BUDGET, grants priority over lower-priority devices
  // where effective, and reserves the device's startup power from lower-priority
  // admission — but NEVER raises the capacity cap (the hard cap holds the tariff
  // step; never a remedy): every one of those only redistributes load WITHIN the
  // cap. The budget-exemption assertion below is defence-in-depth so the
  // exemption can't be smuggled through a generic create — it doesn't rest solely
  // on the widget API being the only caller.
  public rescueDeviceWithBudgetExemption(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): SmartTaskWriteResult {
    // Defence-in-depth (feedback_hard_cap_is_physical): this lane exists only to
    // grant a budget exemption; reject any candidate that does not carry one so
    // the exemption can never be smuggled in through a generic create.
    if (candidate.rescue?.exemptFromBudget !== 'always') {
      return { ok: false, reason: 'invalid_candidate' };
    }
    // Migrate any legacy-blob objective to per-keys BEFORE the eligibility check:
    // a task still only in the un-migrated blob is invisible to the per-key
    // `hasDeferredObjectiveForDevice`, so without this the delegated create would
    // migrate-then-REPLACE it, losing the user's target/deadline. (A transient-
    // empty store defers the migration; the device then still looks task-free
    // here, but `createDeferredObjective`'s own `ensureMigrated` guard refuses the
    // write rather than clobbering — so the user's task is safe either way.)
    migrateBlobToPerKeyIfNeeded(this.ctx.homey.settings);
    // A device that already has an open smart task is not rescuable. Re-assert
    // here (the list already excludes it) so this lane can never REPLACE a user's
    // active or paused future task: the rescue is strictly a fresh create.
    if (this.hasDeferredObjectiveForDevice(deviceId)) {
      return { ok: false, reason: 'device_not_eligible' };
    }
    // `'preserve'`: this lane is a strictly-fresh create (the guard above
    // refuses a device that already has a task), so there is no standing rescue
    // to preserve OR replace — it takes the additive default the widget lane uses.
    return this.createDeferredObjective(deviceId, candidate, SMART_TASK_WIDGET_WRITE_ORIGIN, 'preserve');
  }

}

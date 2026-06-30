/**
 * Persisted record-keeper for deferred-objective active plans — the slow clock
 * in this module's two-clock design (governed by
 * `lib/objectives/deferredObjectives/AGENTS.md`; read it before changing
 * anything here). The recorder owns WHEN the persisted record may change:
 * replan revisions settle at most once per clock hour, at/after the `:58`
 * mark shared with the build-time gate via `settleWindow.ts` (a user
 * objective edit bypasses the gate). Between settles the committed record is
 * frozen — the planner's per-cycle live allocation is deliberately ungated,
 * and the mid-hour frozen read is served elsewhere (`frozenHorizonPlan.ts`),
 * not by this file. The recorder also owns the commitment envelope, the
 * bounded revision history, and the pending-record lifecycle that the
 * settings UI and the public Flow status read.
 *
 * Persistence caveat: Homey settings reads can transiently return
 * missing/empty data, so a persisted plan is never dropped on a single cycle
 * without its diagnostic — `dropExpiredAndAbandoned` waits `ABANDON_GRACE_MS`
 * (one hour) since the device was last seen, and `lastSeenAtMs` is seeded to
 * construction time on reload so a miss right after restart cannot delete
 * persisted plans. Preserve that property when changing load/drop paths.
 */
import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  resolvePlanLevelDurationSnapshot,
  toPersistedPlanLevelDurationFields,
} from './activePlanDuration';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION } from './activePlanSettings';
import { resolveDiagnosticReasonCode, withDiagnosticReasonCode } from './activePlanDiagnosticReason';
import {
  hasPriceHorizonAdvanced,
  resolveReplanReason,
} from './replanReason';
import { getLogger } from '../../logging/logger';
import { buildActivePlanLifecycleFields } from './activePlanLifecycleFields';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import {
  buildHoursFromHorizonPlan,
  mergeHoursPreservingCommitment,
  resolveProjectedFinishAtMs,
  sameHourSchedule,
  shouldFireNotification,
  stampCheaperHourAhead,
  stampUnitMilestones,
} from './activePlanSchedule';
import { SCHEDULE_SETTLE_OFFSET_MS } from './settleWindow';
import { buildObjectiveSignature, compareObjectiveSignatures } from './activePlanSignature';
import {
  buildRevision,
  buildSignatureFromDiagnostic,
  carryInFlightAnchors,
  createPlanFromDiagnostic,
  createPlanFromSeed,
  diagTargetTemperatureC,
  hasLearnedRateDeviated,
  hasMetadataDriftedWithinSchedule,
  MAX_HISTORY_REVISIONS,
  notifyRevisionWrittenIfPubliclyObservable,
  reportedPlanStatus,
  resolveCommitment,
  resolveInitialKwhPerUnit,
  resolveLearnedRateKwh,
  resolvePendingReason,
  resolveProvenance,
  resolveSourceTransition,
  sameHourOpening,
  shouldWriteReplanRevision,
  toInitialKwhPerUnitField,
} from './activePlanRevisionBuild';

// Public types re-exported so importers keep their `./activePlanRecorder` path
// (the definitions moved verbatim into `./activePlanRevisionBuild`).
export type { ActivePlanFlowCardSeed, ActivePlanPersistDeps } from './activePlanRevisionBuild';
import type { ActivePlanFlowCardSeed, ActivePlanPersistDeps } from './activePlanRevisionBuild';

const logger = getLogger('plan/deferred-active');

// Mirror `planHistory.ts` ABANDON_GRACE_MS. Homey settings reads can transiently
// return empty/malformed data; if a plan cycle ever produces an empty
// diagnostic stream we must not drop persisted plans on the first miss. Wait
// at least an hour without seeing the diagnostic before declaring the
// objective abandoned.
const ABANDON_GRACE_MS = 60 * 60 * 1000;

const ONE_HOUR_MS = 60 * 60 * 1000;

// Replan revisions settle once per clock hour, near the end (the `:58` mark), not
// on every plan cycle. By `:58` the elapsed hour's outcome is known and the
// upcoming hour can be scheduled in; settling earlier would churn the persisted
// record on the current hour's capacity trimming (the device may still climb to
// deliver before the hour ends — "we don't know until the end of the hour").
// Mid-hour the diagnostics build serves a FROZEN read of this commitment (no
// allocator — see `frozenHorizonPlan.ts`), so the executor's per-cycle control
// still reacts to live measured power while the plan itself is fixed until the
// next settle. A user objective edit (`objectiveChanged`) is an external event
// and revises immediately (a signature change also forces a fresh build-time
// plan). The `:58` mark is shared with the build-time gate via `./settleWindow`
// so the two clocks agree. See
// notes/deferred-load-objectives/execution-adaptation.md.

export class DeferredObjectiveActivePlanRecorder {
  private plans: Record<string, DeferredObjectiveActivePlanV1>;

  // In-memory only. Records the last cycle that emitted a diagnostic for the
  // device so abandon-grace works after settings reads. Initialized to
  // recorder construction time on reload so a transient SDK miss right after
  // restart does not delete persisted plans.
  private lastSeenAtMs: Map<string, number>;

  // In-memory only. Records the clock hour (floored ms) in which each device last
  // settled a replan revision, so the `:58` settle fires at most once per hour.
  // Not persisted: after a restart the first observe past `:58` simply re-settles,
  // which is a legitimate re-evaluation point.
  private lastScheduleSettledHourMs = new Map<string, number>();

  private dirty = false;

  constructor(private readonly deps: ActivePlanPersistDeps) {
    const loaded = deps.load();
    this.plans = loaded ? { ...loaded.plansByDeviceId } : {};
    const constructedAtMs = Date.now();
    this.lastSeenAtMs = new Map(Object.keys(this.plans).map((id) => [id, constructedAtMs]));
  }

  // Called from the flow card handler so the UI shows a pending hero immediately,
  // before the next plan cycle has a chance to compute a horizon.
  markPending(seed: ActivePlanFlowCardSeed, nowMs: number): void {
    const existing = this.plans[seed.deviceId];
    const signature = buildObjectiveSignature(seed);
    if (existing && existing.deadlineAtMs === seed.deadlineAtMs && existing.objectiveSignature === signature) {
      if (existing.deviceName !== seed.deviceName) {
        this.plans[seed.deviceId] = { ...existing, deviceName: seed.deviceName };
        this.dirty = true;
      }
      return;
    }
    const previousPlanStatus = existing !== undefined && existing.latest !== null && existing.deadlineAtMs > nowMs
      ? existing.latest.planStatus
      : null;
    this.plans[seed.deviceId] = createPlanFromSeed(seed, nowMs);
    this.lastSeenAtMs.set(seed.deviceId, nowMs);
    // Fresh plan (different deadline/signature): drop the prior settle marker so
    // the replacement is not wrongly treated as "already settled this hour".
    this.lastScheduleSettledHourMs.delete(seed.deviceId);
    this.dirty = true;
    if (previousPlanStatus !== null) {
      this.deps.onRevisionWritten?.({
        eventType: 'pending_written',
        deviceId: seed.deviceId,
        deviceName: seed.deviceName,
        objectiveKind: seed.objectiveKind,
        revision: null,
        reason: 'pending',
        previousPlanStatus,
        previousWasPending: false,
        allocationChanged: false,
        projectedFinishAtMs: null,
      });
    }
  }

  // Called from the flow card handler when the objective is cleared.
  clearForDevice(deviceId: string): void {
    if (this.plans[deviceId] === undefined) return;
    delete this.plans[deviceId];
    this.lastSeenAtMs.delete(deviceId);
    this.lastScheduleSettledHourMs.delete(deviceId);
    this.dirty = true;
  }

  // Persist the plan-history recorder's in-flight postmortem anchors onto the
  // matching active plan so a PELS restart mid-run can restore them (otherwise
  // the in-flight hour renders as a falsely-empty bar — "device did nothing").
  // The history recorder owns the anchor computation; this is the single seam it
  // uses to thread the values into the persisted active-plans blob. No-op when no
  // plan tracks `(deviceId, deadlineAtMs)` (the active-plan recorder hasn't seen
  // the diagnostic yet — the next cycle re-stamps once both recorders agree on
  // the run). Dirty only flips when a value actually changed so a steady run does
  // not re-persist the active plans every cycle. Distinct from `observe`: this
  // never writes a revision or touches the `:58` settle gate.
  applyInProgressAnchors(params: {
    deviceId: string;
    deadlineAtMs: number;
    hourOpening: { hourMs: number; value: number } | null;
    kWhPerUnit: number | null;
  }): void {
    const existing = this.plans[params.deviceId];
    if (!existing || existing.deadlineAtMs !== params.deadlineAtMs) return;
    const nextOpening = params.hourOpening ?? undefined;
    // Only persist a finite-positive factor (mirrors the contract guard +
    // `pickKwhPerUnit`); a non-positive/absent factor leaves the field absent.
    const nextKwh = params.kWhPerUnit !== null
      && Number.isFinite(params.kWhPerUnit)
      && params.kWhPerUnit > 0
      ? params.kWhPerUnit
      : undefined;
    const openingUnchanged = sameHourOpening(existing.inFlightHourOpening, nextOpening);
    if (openingUnchanged && existing.inFlightKWhPerUnit === nextKwh) return;
    const updated: DeferredObjectiveActivePlanV1 = { ...existing };
    if (nextOpening === undefined) delete updated.inFlightHourOpening;
    else updated.inFlightHourOpening = nextOpening;
    if (nextKwh === undefined) delete updated.inFlightKWhPerUnit;
    else updated.inFlightKWhPerUnit = nextKwh;
    this.plans[params.deviceId] = updated;
    this.dirty = true;
  }

  // Per-cycle observation. Reads `horizonPlan` from each diagnostic and updates
  // the persisted plan iff a replan trigger fires.
  observe(diagnostics: readonly DeferredObjectiveDiagnostic[], nowMs: number): void {
    for (const diag of diagnostics) {
      if (diag.deadlineAtMs === null) continue;
      if (diag.deadlineAtMs <= nowMs) {
        this.dropPlanForRuntimeReason(diag.deviceId, 'deadline_passed');
        continue;
      }
      this.lastSeenAtMs.set(diag.deviceId, nowMs);
      this.observeDiagnostic(diag, nowMs);
    }
    this.dropExpiredAndAbandoned(nowMs);
  }

  private observeDiagnostic(diag: DeferredObjectiveDiagnostic, nowMs: number): void {
    const signature = buildSignatureFromDiagnostic(diag);
    if (signature === null) return;
    const existing = this.plans[diag.deviceId];
    // A previous record for a different deadline is stale — replace it.
    if (existing && existing.deadlineAtMs !== diag.deadlineAtMs) {
      delete this.plans[diag.deviceId];
      this.lastScheduleSettledHourMs.delete(diag.deviceId);
    }
    const candidateHours = buildHoursFromHorizonPlan(diag);
    if (candidateHours === null) {
      // Diagnostic without horizonPlan (e.g. prices missing): can't compute a
      // revision. Auto-create a pending record so the UI knows the objective
      // is being tracked. Unit milestones are stamped downstream — in
      // `writeFirstRevision` (no merge) and `maybeWriteReplanRevision` (on the
      // MERGED hours) — never on these pre-merge candidate hours, which the merge
      // would then preserve at the wrong (pre-floor / live-anchored) value.
      this.ensurePendingRecord(diag, signature, nowMs);
      return;
    }
    const current = this.plans[diag.deviceId];
    if (!current) {
      // No prior record; the recorder discovered the objective via the
      // diagnostic itself (e.g. objective enabled before this code shipped, or
      // app restarted without persisted state). Treat the original cause as
      // the flow card.
      this.writeFirstRevision(diag, signature, candidateHours, 'flow_card', nowMs);
      return;
    }
    if (current.pending || current.latest === null) {
      // Was waiting for prices (or freshly seeded); now we have an allocation.
      const reason: DeferredObjectiveActivePlanRevisionReason = current.pending && current.startedAtMs < nowMs
        ? 'prices_arrived'
        : 'flow_card';
      this.writeFirstRevision(diag, signature, candidateHours, reason, nowMs);
      return;
    }
    const backfilled = this.refreshDiagnosticReasonCode(
      this.backfillCommitmentIfMissing(current, signature, nowMs),
      diag,
    );
    // End-of-hour settle gate: a replan revision settles at most once per clock
    // hour (at/after :58); a user objective edit bypasses it. The planner's
    // per-cycle live allocation is unaffected — only the persisted RECORD is
    // gated, so the device stays controlled while the record waits for the hour's
    // outcome. The hour's settle slot is consumed only when a revision is actually
    // written (`markReplanSettled` after a truthy write), so a no-op `:58` cycle
    // doesn't starve a real change later in the same `:58` window.
    const objectiveChanged = compareObjectiveSignatures(backfilled.objectiveSignature, signature).changed;
    if (!this.isReplanDueThisCycle(diag.deviceId, objectiveChanged, nowMs)) return;
    if (this.maybeWriteReplanRevision(diag, signature, candidateHours, backfilled, nowMs)) {
      this.markReplanSettled(diag.deviceId, nowMs);
    }
  }

  // Plans persisted before the stable-schedule commitment shipped (v2.7.3 and
  // earlier) carry `latest.hours` but no `commitment`, which causes
  // `maybeWriteReplanRevision` and `resolveCommittedHours` to keep treating the
  // allocation as advisory — the executor re-optimises every cycle. Quietly
  // adopt the existing `latest.hours` as the committed envelope so the
  // post-upgrade behaviour matches new plans. No revision is emitted: this is
  // a data-shape migration, not a user-visible replan.
  //
  // Caller has already ensured `!current.pending` and `current.latest !== null`.
  // Skipping when `latest.hours` is empty preserves the "no hours scheduled"
  // shape rather than committing to an empty envelope. We do not race with
  // `markPending` / `clearForDevice`: both run synchronously from flow card
  // handlers, and any plan with `latest !== null` has already left the pending
  // state — so by the time we reach this path the legacy record is stable
  // enough to commit.
  //
  // We also gate the backfill on the persisted `objectiveSignature` matching
  // the current diagnostic's resolved signature. When they differ (e.g. the
  // user changed the target/enforcement before the upgrade was observed), the
  // persisted `latest.hours` correspond to the OLD objective — committing to
  // them would lock in stale hours for the new target. In that case we skip;
  // `maybeWriteReplanRevision` will then detect the signature change and
  // write a fresh revision with the correct commitment via the first-revision
  // path.
  private backfillCommitmentIfMissing(
    current: DeferredObjectiveActivePlanV1,
    currentSignature: string,
    nowMs: number,
  ): DeferredObjectiveActivePlanV1 {
    if (current.commitment) return current;
    if (current.objectiveSignature !== currentSignature) return current;
    const latest = current.latest as DeferredObjectiveActivePlanRevisionV1;
    if (latest.hours.length === 0) return current;
    const backfilled: DeferredObjectiveActivePlanV1 = {
      ...current,
      commitment: {
        committedAtMs: nowMs,
        hours: latest.hours,
      },
    };
    this.plans[current.deviceId] = backfilled;
    this.dirty = true;
    return backfilled;
  }

  // Keep a committed plan's `diagnosticReasonCode` in lock-step with the live
  // diagnostic on EVERY cycle — not only when a replan is due. The list chip and
  // device-card line read this field to surface "Paused — unplugged" /
  // "Can't resume" even on a plan with a cached `latest` revision. Without a
  // per-cycle refresh, a charger that RECOVERS (re-plugged, or resume succeeds)
  // while no replan is due — the `isReplanDueThisCycle` gate early-returns most
  // cycles — would keep advertising the stale `objective_invalid_session` /
  // `objective_charger_not_resumable` code until the next `:58` replan, so the
  // chip lies "Can't resume" on a healthy charger. `ensurePendingRecord` already
  // refreshes this on the no-`horizonPlan` path; this mirrors it on the
  // committed-plan path. Returns the (possibly updated) record so the caller
  // feeds the corrected code into `maybeWriteReplanRevision`'s `...current`
  // spread, which would otherwise carry the stale code across a replan write too.
  private refreshDiagnosticReasonCode(
    current: DeferredObjectiveActivePlanV1,
    diag: DeferredObjectiveDiagnostic,
  ): DeferredObjectiveActivePlanV1 {
    const code = resolveDiagnosticReasonCode(diag);
    if (current.diagnosticReasonCode === code) return current;
    this.plans[current.deviceId] = withDiagnosticReasonCode(current, code);
    this.dirty = true;
    return this.plans[current.deviceId]!;
  }

  private ensurePendingRecord(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    nowMs: number,
  ): void {
    const existing = this.plans[diag.deviceId];
    if (existing !== undefined) {
      // Non-pending records (a persisted revision that's gone invalid mid-plan,
      // e.g. EV unplugged) share the committed-plan refresh path: only the
      // `diagnosticReasonCode` needs to track the live diagnostic — `pendingReason`
      // is meaningless once a plan has executed.
      if (!existing.pending) {
        this.refreshDiagnosticReasonCode(existing, diag);
        return;
      }
      // Pending records refresh both `pendingReason` and `diagnosticReasonCode`.
      const pendingReason = resolvePendingReason(diag);
      const diagnosticReasonCode = resolveDiagnosticReasonCode(diag);
      if (existing.pendingReason !== pendingReason || existing.diagnosticReasonCode !== diagnosticReasonCode) {
        this.plans[diag.deviceId] = withDiagnosticReasonCode({ ...existing, pendingReason }, diagnosticReasonCode);
        this.dirty = true;
      }
      return;
    }
    this.plans[diag.deviceId] = createPlanFromDiagnostic(diag, signature, nowMs);
    this.dirty = true;
    this.emit({
      event: 'active_plan_revision_pending',
      deviceId: diag.deviceId,
      reason: 'awaiting_horizon_plan',
      ...buildActivePlanLifecycleFields(diag, this.plans[diag.deviceId]!.startedAtMs),
    });
  }

  private writeFirstRevision(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    rawHours: DeferredObjectiveActivePlanHourV1[],
    reason: DeferredObjectiveActivePlanRevisionReason,
    nowMs: number,
  ): void {
    // First commit: no prior commitment to merge, so stamp the live hours directly
    // (the first hour seeds at the measured anchor; cumulative is correct). Stamp
    // the frozen `cheaperHourAhead` flag here too so the first committed hours
    // carry it from the start.
    const hours = stampCheaperHourAhead(stampUnitMilestones(rawHours, diag, nowMs), diag);
    const revision = buildRevision({ diag, hours, revision: 1, reason, nowMs });
    const previous = this.plans[diag.deviceId];
    const previousWasPending = previous !== undefined && (previous.pending || previous.latest === null);
    const startedAtMs = previous?.startedAtMs ?? nowMs;
    const provenance = resolveProvenance(diag);
    const initialKwhPerUnit = resolveLearnedRateKwh(diag);
    // Freeze the plan-level total duration here so the hero meta line stays
    // stable across revisions. See `resolvePlanLevelDurationSnapshot` for the
    // preservation/reset rules applied during subsequent revisions.
    this.plans[diag.deviceId] = {
      deviceId: diag.deviceId,
      deviceName: diag.deviceName ?? null,
      objectiveKind: diag.objectiveKind,
      targetTemperatureC: diagTargetTemperatureC(diag),
      targetPercent: diag.targetPercent,
      deadlineAtMs: diag.deadlineAtMs as number,
      startedAtMs,
      pending: false,
      objectiveSignature: signature,
      commitment: {
        committedAtMs: nowMs,
        hours,
      },
      ...(provenance ? { kwhPerUnitProvenance: provenance } : {}),
      // Freeze the committed learned-rate baseline for `measured_deviation`.
      // Omitted when the first revision is still on the bootstrap fallback (no
      // learned rate yet) — the baseline backfills on the first later cycle
      // whose source is `learned` (see `resolveInitialKwhPerUnit`).
      ...toInitialKwhPerUnitField(initialKwhPerUnit ?? undefined),
      ...(revision.planningSpeedKw !== undefined ? { initialPlanningSpeedKw: revision.planningSpeedKw } : {}),
      ...(revision.estimatedDurationText !== undefined
        ? { initialEstimatedDurationText: revision.estimatedDurationText }
        : {}),
      // Preserve any postmortem in-flight anchor the plan-history recorder
      // already persisted for THIS run (same deadline — a different-deadline
      // record is deleted upstream). Without this, the pending→first-revision
      // transition would drop a just-restored anchor and a restart in the
      // intervening cycle would blank the in-flight hour's postmortem bar. The
      // history recorder re-stamps it next cycle regardless; this just closes
      // the one-cycle window.
      ...carryInFlightAnchors(previous),
      original: revision,
      latest: revision,
    };
    this.dirty = true;
    this.emit({
      event: 'active_plan_revision_written',
      deviceId: diag.deviceId,
      revision: 1,
      reason,
      hourCount: hours.length,
      ...buildActivePlanLifecycleFields(diag, startedAtMs),
    });
    if (previousWasPending) {
      this.deps.onRevisionWritten?.({
        eventType: 'revision_written',
        deviceId: diag.deviceId,
        deviceName: diag.deviceName ?? previous?.deviceName ?? null,
        objectiveKind: diag.objectiveKind,
        revision,
        reason,
        previousPlanStatus: null,
        previousWasPending: true,
        allocationChanged: false,
        projectedFinishAtMs: resolveProjectedFinishAtMs(diag),
      });
    }
  }

  // The once-per-hour `:58` settle gate (see SCHEDULE_SETTLE_OFFSET_MS). True when
  // a replan revision MAY be written this cycle: an external objective edit
  // (immediate) OR the first cycle at/after `:58` of this clock hour that has not
  // yet settled a write. PURE — the settle marker is advanced by
  // `markReplanSettled` only after a revision is ACTUALLY written, so a no-op
  // `:58` cycle (no schedule/metadata/source drift) does not consume the hour's
  // slot and a real change later in the `:58` window still lands. Within the hour
  // the persisted plan is otherwise frozen; the planner's per-cycle live
  // allocation still reacts (device stays controlled) — only the RECORD waits.
  private isReplanDueThisCycle(
    deviceId: string,
    objectiveChanged: boolean,
    nowMs: number,
  ): boolean {
    if (objectiveChanged) return true;
    const currentHourMs = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
    const pastSettleMark = nowMs - currentHourMs >= SCHEDULE_SETTLE_OFFSET_MS;
    return pastSettleMark && this.lastScheduleSettledHourMs.get(deviceId) !== currentHourMs;
  }

  // Advance the settle marker after an actual `:58` write so the next cycle in the
  // same hour is frozen. Objective-edit writes that land mid-hour (before the
  // mark) do NOT consume the hour's settle slot — the end-of-hour settle still
  // runs to record the hour's outcome.
  private markReplanSettled(deviceId: string, nowMs: number): void {
    const currentHourMs = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
    if (nowMs - currentHourMs >= SCHEDULE_SETTLE_OFFSET_MS) {
      this.lastScheduleSettledHourMs.set(deviceId, currentHourMs);
    }
  }

  private maybeWriteReplanRevision(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    hours: DeferredObjectiveActivePlanHourV1[],
    current: DeferredObjectiveActivePlanV1,
    nowMs: number,
  ): boolean {
    // Caller (`observeDiagnostic`) already returns early when `current.latest`
    // is null, so we can dereference it directly here.
    const latest = current.latest as DeferredObjectiveActivePlanRevisionV1;
    const horizonPlan = diag.horizonPlan as NonNullable<typeof diag.horizonPlan>;
    // `rescueOnly` routes to `flow_permission_changed` below so the history detail
    // names the Flow permission change, not a generic objective edit.
    const sigDiff = compareObjectiveSignatures(current.objectiveSignature, signature);
    const objectiveChanged = sigDiff.changed;
    // When the objective signature changes, the previous commitment is
    // discarded and the live `hours` become the new commitment. Otherwise
    // we merge live into commitment so per-cycle growth (within-hour drift
    // or phase-2 expansion) extends the commitment while the existing
    // committed kWh is preserved as a floor against transient shrinkage —
    // see `mergeHoursPreservingCommitment` for the merge rules.
    // Stamp the unit-trajectory milestones AND the frozen `cheaperHourAhead` flag
    // on the MERGED hours (not the pre-merge live plan): the Math.max floor can
    // raise an earlier hour's kWh, and the milestone cumulative must include that
    // or downstream milestones understate the target and the gate mis-releases.
    // Both stamps freeze per hour at the booking revision and carry through later
    // merges via `{ ...c }`. See `stampUnitMilestones` / `stampCheaperHourAhead`.
    const mergedHours = objectiveChanged
      ? hours
      : mergeHoursPreservingCommitment(current.commitment?.hours ?? [], hours, nowMs);
    const effectiveHours = stampCheaperHourAhead(stampUnitMilestones(mergedHours, diag, nowMs), diag);
    // Schedule change = user-visible "new plan" (set of charging hours).
    // Drives the `deadline_plan_changed` flow trigger.
    const scheduleChanged = !sameHourSchedule(latest.hours, effectiveHours);
    // Same charging hours but consumer-visible status fields drifted — see
    // `hasMetadataDriftedWithinSchedule` for the field list. Covers
    // `planStatus` transitions (drives the "Can't fully meet" chip) and
    // `dailyBudgetExhaustedBucketCount` (drives the per-bucket headroom
    // explanation). Per-cycle drift in `plannedKWh` / `energyNeededKWh` is
    // intentionally excluded to keep settings I/O budget in check on actively
    // charging EVs.
    const metadataDriftedWithinSchedule = !scheduleChanged
      && hasMetadataDriftedWithinSchedule({ latest, horizonPlan, diag });
    // Any kwhPerUnitSource change is a replan trigger so persisted metadata
    // (`kwhPerUnitSource`, `energyNeededKWh`, `planStatus`) cannot go stale
    // when the bucket allocation happens to be byte-identical across a source
    // flip. The reason is only `rate_refined` for the bootstrap→learned
    // direction; the rarer learned→bootstrap regression (profile pruned at
    // retention or device removed) falls through to `prices_revised`.
    //
    // `null` means the resolver did not consult a profile (e.g. target is
    // already satisfied so `energyNeededKWh = 0`). Treat that as "no source
    // change" rather than coercing it to `'learned'` — otherwise a bootstrap
    // revision followed by a satisfied diagnostic would spuriously fire
    // `rate_refined` even though nothing was learned.
    const { sourceChanged, sourceRefined } = resolveSourceTransition({ latest, diag });
    // The live learned per-unit energy rate (kWh/°C or kWh/%) drifted away from
    // the rate the committed plan was built against (`current.initialKwhPerUnit`)
    // — the device needs materially more/less energy per unit of progress than
    // planned, so the committed bucket allocation's energy assumption is stale.
    // Gated on a learned rate both sides (see `hasLearnedRateDeviated`), so
    // bootstrap/cold-start and idle live-power readings never reach it.
    // TODO: device_unavailable trigger — wired here once device-level metering
    // distinguishes "unreachable" from a slow reading.
    const measuredDeviation = hasLearnedRateDeviated({ current, diag, objectiveChanged });
    if (!shouldWriteReplanRevision({
      objectiveChanged,
      scheduleChanged,
      metadataDriftedWithinSchedule,
      sourceChanged,
      measuredDeviation,
    })) return false;
    const reason = resolveReplanReason({
      objectiveChanged,
      rescuePermissionOnlyChanged: sigDiff.rescueOnly,
      sourceRefined,
      measuredDeviation,
      pricesAdvanced: hasPriceHorizonAdvanced(latest, diag),
    });
    const nextRevision = latest.revision + 1;
    const revision = buildRevision({
      diag, hours: effectiveHours, revision: nextRevision, reason, nowMs,
      previousPricesUpTo: latest.computedFromPricesUpTo,
    });
    const provenance = resolveProvenance(diag);
    // Provenance updates are best-effort; preserve the existing snapshot when
    // the new diagnostic didn't resolve a profile so we don't clobber useful
    // accepted-sample counts with a transient `null`. Don't carry the
    // snapshot across an objective-kind change on the same device id —
    // accepted-sample counts and confidence are kind-specific.
    const nextProvenance = provenance
      ?? (current.objectiveKind === diag.objectiveKind ? current.kwhPerUnitProvenance : undefined);
    const snapshot = resolvePlanLevelDurationSnapshot({ current, revision, reason });
    // Drop the prior snapshot fields from `...current` so the
    // `objective_changed` reset path can genuinely omit them when the new
    // revision has no usable planning speed. `toPersistedPlanLevelDurationFields`
    // then re-adds the keys only when the resolved snapshot has a value, so
    // the persisted JSON.stringify output stays identical to the prior
    // explicit-undefined idiom while the in-memory shape no longer exposes
    // `undefined` keys that violate `exactOptionalPropertyTypes`-style
    // contracts.
    const nextInitialKwhPerUnit = resolveInitialKwhPerUnit({
      current, diag, objectiveChanged, measuredDeviation,
    });
    const {
      initialPlanningSpeedKw: _droppedSnapshotSpeed,
      initialEstimatedDurationText: _droppedSnapshotDurationText,
      initialKwhPerUnit: _droppedInitialRate,
      ...currentWithoutSnapshot
    } = current;
    this.plans[diag.deviceId] = {
      ...currentWithoutSnapshot,
      deviceName: diag.deviceName ?? current.deviceName,
      objectiveKind: diag.objectiveKind,
      targetTemperatureC: diagTargetTemperatureC(diag),
      targetPercent: diag.targetPercent,
      objectiveSignature: signature,
      // Persist the merged `effectiveHours` as the commitment when the
      // schedule has changed (i.e. expansion added one or more new hours).
      // `committedAtMs` advances to nowMs on each grow so consumers can
      // reason about "when did this hour join the plan". When the schedule
      // is unchanged, preserve the existing commitment (including its
      // original `committedAtMs`) so within-schedule metadata drift doesn't
      // visibly reshape the commitment timestamp.
      commitment: resolveCommitment({
        objectiveChanged,
        scheduleChanged,
        effectiveHours,
        previous: current.commitment,
        nowMs,
      }),
      ...(nextProvenance ? { kwhPerUnitProvenance: nextProvenance } : {}),
      ...toPersistedPlanLevelDurationFields(snapshot),
      ...toInitialKwhPerUnitField(nextInitialKwhPerUnit),
      latest: revision,
      // Prepend the prior `latest` onto the history log, FIFO-pruned to the
      // cap so the persisted blob stays bounded. The head of the array is
      // always "the revision immediately before the current `latest`."
      //
      // Exception: when the smart-task settings themselves changed
      // (`reason === 'objective_changed'`), the prior history belongs to a
      // different objective (target, deadline, or device). Carrying it
      // forward would interleave pre-change revisions with the new
      // objective's revisions in the smart-task detail page revision panel
      // until 20 fresh entries rolled over. Clear instead — the new `latest`
      // revision carries reason `'objective_changed'` ("Smart task settings
      // changed"), which is itself the natural separator the user sees.
      //
      // Rescue-permission-only toggles (`reason === 'flow_permission_changed'`)
      // intentionally do NOT clear history: the target / deadline / device
      // are unchanged, and the user benefits from continuity of the prior
      // schedule's revisions across a permission edit.
      history: reason === 'objective_changed'
        ? []
        : [latest, ...(current.history ?? [])].slice(0, MAX_HISTORY_REVISIONS),
      // Drop the prior run's postmortem in-flight anchors on an objective change
      // — they belong to a DIFFERENT run (new target/deadline/device). The
      // history recorder finalizes the old run and starts a fresh one, whose
      // `startRecord` must NOT restore the stale opening (it would mis-attribute
      // the first post-change rollover against an old hour/reading). The fresh
      // run re-stamps a correct anchor on its next cycle. Spreading
      // `...currentWithoutSnapshot` above carried them; override to absent here.
      ...(reason === 'objective_changed' ? { inFlightHourOpening: undefined, inFlightKWhPerUnit: undefined } : {}),
    };
    this.dirty = true;
    this.emit({
      event: 'active_plan_revision_written',
      deviceId: diag.deviceId,
      revision: nextRevision,
      reason,
      hourCount: effectiveHours.length,
      ...buildActivePlanLifecycleFields(diag, current.startedAtMs),
    });
    const allocationChanged = shouldFireNotification(
      latest.hours.length,
      effectiveHours.length,
      reportedPlanStatus(diag, horizonPlan),
    );
    notifyRevisionWrittenIfPubliclyObservable({
      deps: this.deps,
      diag,
      current,
      latest,
      revision,
      reason,
      allocationChanged,
    });
    return true;
  }

  private dropExpiredAndAbandoned(nowMs: number): void {
    for (const [deviceId, plan] of Object.entries(this.plans)) {
      if (plan.deadlineAtMs <= nowMs) {
        this.dropPlanForRuntimeReason(deviceId, 'deadline_passed');
        continue;
      }
      // Diagnostic stopped appearing while the deadline is still in the
      // future. This could be objective disabled, device unavailable, or a
      // transient empty Homey settings read. Wait for the abandon grace
      // before dropping so a single bad cycle does not delete persisted
      // state. A re-enabled objective produces a fresh objectiveSignature
      // which observe() picks up via objective_changed before grace expires.
      const lastSeen = this.lastSeenAtMs.get(deviceId) ?? nowMs;
      if (nowMs - lastSeen >= ABANDON_GRACE_MS) {
        this.dropPlanForRuntimeReason(deviceId, 'objective_inactive');
      }
    }
  }

  private dropPlanForRuntimeReason(
    deviceId: string,
    reason: 'deadline_passed' | 'objective_inactive',
  ): void {
    if (this.plans[deviceId] === undefined) return;
    delete this.plans[deviceId];
    this.lastSeenAtMs.delete(deviceId);
    this.lastScheduleSettledHourMs.delete(deviceId);
    this.dirty = true;
    this.emit({ event: 'active_plan_dropped', deviceId, reason });
  }

  flushIfDirty(): boolean {
    if (!this.dirty) return false;
    this.deps.save({
      version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
      plansByDeviceId: { ...this.plans },
    });
    this.dirty = false;
    return true;
  }

  getActivePlansSnapshot(): DeferredObjectiveActivePlansV1 {
    return {
      version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
      plansByDeviceId: { ...this.plans },
    };
  }

  // Test seam: expose internals for assertions without going through save().
  getPlanForTests(deviceId: string): DeferredObjectiveActivePlanV1 | undefined {
    return this.plans[deviceId];
  }

  resetForTests(): void {
    this.plans = {};
    this.lastSeenAtMs.clear();
    this.lastScheduleSettledHourMs.clear();
    this.dirty = false;
  }

  private emit(payload: Record<string, unknown>): void {
    if (this.deps.debugStructured) {
      this.deps.debugStructured(payload);
    } else {
      logger.debug(payload);
    }
  }
}

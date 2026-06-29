/**
 * Soft-overshoot bookkeeping, attribution diagnostics, and the per-cycle plan
 * snapshot the builder diffs against, sliced out of `planBuilder.ts` to keep
 * that entry point under the line budget.
 *
 * `OvershootTracker` owns the overshoot path: it holds the shared
 * `PlanEngineState` and the log/diagnostics/pending-command seams as fields, so
 * the state mutations stay on `this.state` exactly as they did when these were
 * `PlanBuilder` methods. Behaviour is byte-for-byte unchanged: the overshoot
 * entered/cleared/attributed logs, the attribution-reason classification, the
 * tracked-device snapshot, and the `PlanEngineState` mutations (overshoot
 * clocks, `lastPlan*` snapshot, activation-setback penalties) are identical.
 * Pure helpers that read no shared state stay free functions below.
 *
 * `lib/plan` is hot-path: no spread/Array.from in loops, no Array#forEach.
 */
import type CapacityGuard from '../power/capacityGuard';
import type { PowerTrackerState } from '../power/tracker';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { isCooldownBlockedReason } from '../planContract/planDecisionSemantics';
import type { DevicePlanDevice } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { isBinaryPlanDevice } from './planBinaryDevice';
import type { OvershootTrackedPlanDevice, PlanEngineState } from './planState';
import type { PlanContext } from './planContext';
import { buildPlanCapacityStateSummary } from './planLogging';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { Logger as PinoLogger } from '../logging/logger';
import { recordActivationSetback } from './admission';
import {
  OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS,
  SOFT_OVERSHOOT_DEADBAND_KW,
} from './planConstants';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import type { SoftOvershootDecision } from './planOvershoot';
import { buildPlanContextHeadroomLogFields } from './planBuilderMeta';

const OVERSHOOT_DELTA_EPSILON_KW = 0.05;
const OVERSHOOT_TOP_CONTRIBUTOR_LIMIT = 3;

// The log/diagnostics/pending-command seams the overshoot path reads. Read live
// off the shared deps object every cycle (never snapshotted at construction):
// callers — including tests — may swap `structuredLog` after the tracker is
// built, exactly as the former `this.deps.structuredLog` reads did.
export type OvershootTrackerDeps = {
  structuredLog?: PinoLogger;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
};

export class OvershootTracker {
  constructor(
    private readonly state: PlanEngineState,
    private readonly deps: OvershootTrackerDeps,
  ) { }

  public updateOvershootState(params: {
    context: PlanContext;
    capacityGuard: CapacityGuard | undefined;
    capacityLimitKw: number;
    powerTracker: PowerTrackerState;
    deviceNameById: ReadonlyMap<string, string>;
    planDevices: DevicePlanDevice[];
    overshootDecision: SoftOvershootDecision;
    nowTs: number;
  }): void {
    const {
      context,
      capacityGuard,
      capacityLimitKw,
      powerTracker,
      deviceNameById,
      planDevices,
      overshootDecision,
      nowTs,
    } = params;
    const overshootActive = overshootDecision.actionable;
    const prevOvershoot = this.state.wasOvershoot;
    const trackedPlanDevicesById = trackPlanDevicesForOvershoot(
      planDevices,
      this.state,
      this.deps.pendingBinaryCommandStore,
    );
    const lastPowerUpdateMs = powerTracker.lastTimestamp ?? null;
    const overshootTimingFields = this.buildOvershootTimingFields(nowTs, lastPowerUpdateMs);
    if (overshootActive && !prevOvershoot) {
      this.state.overshootLogged = true;
      this.state.overshootStartedMs = nowTs;
      this.state.lastOvershootEscalationMs = null;
      this.state.lastOvershootMitigationMs = null;
      const overshootDiagnostics = buildOvershootEntryDiagnostics({
        context,
        nowTs,
        lastPowerUpdateMs,
        previousTotalKw: this.state.lastPlanTotalKw,
        previousBuiltAtMs: this.state.lastPlanBuiltAtMs,
        previousDevicesById: this.state.lastPlanDevicesById,
        currentDevicesById: trackedPlanDevicesById,
      });
      this.deps.structuredLog?.info({
        event: 'overshoot_entered',
        reasonCode: 'active_overshoot',
        headroomKw: context.headroom,
        ...overshootTimingFields,
        ...buildPlanContextHeadroomLogFields(context, capacityGuard, capacityLimitKw),
        ...buildPlanCapacityStateSummary({
          meta: {
            totalKw: context.total,
            softLimitKw: context.softLimit,
            headroomKw: context.headroom,
          },
          devices: planDevices,
        }),
        ...overshootDiagnostics.logFields,
      });
      this.attributeOvershootToRecentRestores(deviceNameById, nowTs, overshootDiagnostics);
    } else if (!overshootActive && prevOvershoot && this.state.overshootLogged) {
      this.state.overshootLogged = false;
      const durationMs = this.state.overshootStartedMs !== null
        ? Math.max(0, nowTs - this.state.overshootStartedMs)
        : 0;
      this.state.overshootStartedMs = null;
      this.state.lastOvershootEscalationMs = null;
      this.state.lastOvershootMitigationMs = null;
      this.deps.structuredLog?.info({
        event: 'overshoot_cleared',
        reasonCode: 'overshoot_cleared',
        durationMs,
        ...overshootTimingFields,
        ...buildPlanContextHeadroomLogFields(context, capacityGuard, capacityLimitKw),
      });
    } else if (overshootActive && this.state.overshootStartedMs === null) {
      this.state.overshootStartedMs = nowTs;
    }
    this.rememberPlanSnapshot(context, trackedPlanDevicesById, nowTs);
    this.state.wasOvershoot = overshootActive;
  }

  private rememberPlanSnapshot(
    context: PlanContext,
    trackedPlanDevicesById: Record<string, OvershootTrackedPlanDevice>,
    nowTs: number,
  ): void {
    this.state.lastPlanTotalKw = context.total;
    this.state.lastPlanBuiltAtMs = nowTs;
    this.state.lastPlanDevicesById = trackedPlanDevicesById;
  }

  private attributeOvershootToRecentRestores(
    deviceNameById: ReadonlyMap<string, string>,
    nowTs: number,
    overshootDiagnostics: OvershootEntryDiagnostics,
  ): void {
    // Only attribute to the single most recently restored device — it was the marginal addition
    // that tipped headroom negative. Devices restored earlier were already absorbed without
    // triggering overshoot, so penalizing them would be a false attribution.
    if (
      overshootDiagnostics.totalDeltaKw === null
      || overshootDiagnostics.totalDeltaKw <= SOFT_OVERSHOOT_DEADBAND_KW
    ) {
      return;
    }
    const recentRestores = Object.entries(this.state.lastDeviceRestoreMs)
      .filter(([, restoreMs]) => nowTs - restoreMs <= OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS)
      .sort((left, right) => right[1] - left[1]);
    for (const [deviceId, restoreMs] of recentRestores) {
      const contributingRestore = overshootDiagnostics.contributors.find((contributor) => (
        contributor.deviceId === deviceId
        && contributor.controllable
        && contributor.deltaKw > 0
      ));
      if (!contributingRestore) continue;
      const deviceName = deviceNameById.get(deviceId);
      const result = recordActivationSetback({ state: this.state, deviceId, nowTs });
      if (!result.transition) continue;

      const logEntry: {
        event: string;
        deviceId: string;
        deviceName?: string;
        restoreAgeMs: number;
        penaltyLevel: number;
      } = {
        event: 'overshoot_attributed',
        deviceId,
        restoreAgeMs: nowTs - restoreMs,
        penaltyLevel: result.penaltyLevel,
      };
      if (typeof deviceName === 'string' && deviceName.length > 0) {
        logEntry.deviceName = deviceName;
      }
      this.deps.structuredLog?.info(logEntry);
      if (this.deps.deviceDiagnostics) {
        this.deps.deviceDiagnostics.recordActivationTransition(result.transition, { name: deviceName });
      }
      return;
    }
  }

  private buildOvershootTimingFields(
    nowTs: number,
    lastPowerUpdateMs: number | null,
  ): {
    lastPlanBuildAgeMs: number | null;
    lastPowerUpdateAgeMs: number | null;
  } {
    return {
      lastPlanBuildAgeMs: typeof this.state.lastPlanBuiltAtMs === 'number'
        ? Math.max(0, nowTs - this.state.lastPlanBuiltAtMs)
        : null,
      lastPowerUpdateAgeMs: lastPowerUpdateMs !== null ? Math.max(0, nowTs - lastPowerUpdateMs) : null,
    };
  }
}

type OvershootEntryContributor = {
  deviceId: string;
  deviceName: string;
  deltaKw: number;
  previousPowerSource: ResolvedPowerSource;
  newPowerSource: ResolvedPowerSource;
  controllable: boolean;
  expectedByPreviousPlan: boolean | null;
  changedDuringPendingWindow: boolean;
  changedDuringCooldownWindow: boolean;
  measuredExceedsExpectedKw: number | null;
};

type ResolvedPowerSource = 'measured' | 'expected' | 'planning' | 'off' | 'unknown';

// Explains why no managed device could be named as the cause of the overshoot.
// Only set when the contributor arrays are empty (attribution unavailable). Every
// value here must be PROVABLY true from the diff inputs in scope; the confident
// causes are gated behind a single completeness assessment so no edge can sneak a
// confident-but-wrong verdict through. Operators retain the raw
// `overshootUnattributedDeltaKw` / `overshootAttributionDeltaKw` fields for finer
// detail.
//  - no_previous_snapshot: true cold start — there is no prior plan baseline to
//    diff against (the engine has not built a plan yet this lifetime).
//  - attribution_inputs_incomplete: the attribution inputs were not complete-and-fresh
//    this cycle, so no confident cause can be proven. This single honest reason folds
//    every uncertainty: a missing/stale current whole-home sample (the diff would be
//    computed off a stale cached total), a missing previous total, OR a tracked device
//    (controllable or uncontrolled) that plausibly carried the rise — its current read
//    sits above the attribution epsilon — but could not be diffed (current or previous
//    power unresolvable). Any of these means the rise could be a device PELS merely
//    failed to read, so we never blame background load.
//  - background_load_dominant: the sample was fresh, a prior baseline existed, and every
//    tracked device that could plausibly have contributed was diffable, yet the rise
//    lives in unmanaged/background load that PELS does not track per-device.
//  - all_deltas_below_epsilon: inputs were complete-and-fresh and no managed device rose
//    above the attribution epsilon (the whole-home rise itself stayed below epsilon).
type OvershootAttributionReason =
  | 'no_previous_snapshot'
  | 'attribution_inputs_incomplete'
  | 'background_load_dominant'
  | 'all_deltas_below_epsilon';

type OvershootEntryDiagnostics = {
  totalDeltaKw: number | null;
  contributors: OvershootEntryContributor[];
  logFields: {
    overshootPlanAgeMs: number | null;
    overshootPowerSampleAgeMs: number | null;
    overshootTotalDeltaKw: number | null;
    overshootAttributionDeltaKw: number;
    overshootUnattributedDeltaKw: number | null;
    overshootAttributionReason: OvershootAttributionReason | null;
    overshootTopControlledContributors: OvershootEntryContributor[];
    overshootTopUncontrolledContributors: OvershootEntryContributor[];
  };
};

function buildOvershootEntryDiagnostics(params: {
  context: PlanContext;
  nowTs: number;
  lastPowerUpdateMs: number | null;
  previousTotalKw: number | null;
  previousBuiltAtMs: number | null;
  previousDevicesById: Record<string, OvershootTrackedPlanDevice>;
  currentDevicesById: Record<string, OvershootTrackedPlanDevice>;
}): OvershootEntryDiagnostics {
  const {
    context,
    nowTs,
    lastPowerUpdateMs,
    previousTotalKw,
    previousBuiltAtMs,
    previousDevicesById,
    currentDevicesById,
  } = params;
  const contributors = Object.values(currentDevicesById)
    .map((device) => buildOvershootContributor(device, previousDevicesById[device.id]))
    .filter((contributor): contributor is OvershootEntryContributor => contributor !== null)
    .sort((left, right) => right.deltaKw - left.deltaKw);
  const controlled = contributors
    .filter((contributor) => contributor.controllable)
    .slice(0, OVERSHOOT_TOP_CONTRIBUTOR_LIMIT);
  const uncontrolled = contributors
    .filter((contributor) => !contributor.controllable)
    .slice(0, OVERSHOOT_TOP_CONTRIBUTOR_LIMIT);
  const totalDeltaKw = (
    typeof context.total === 'number'
    && typeof previousTotalKw === 'number'
    && Number.isFinite(context.total)
    && Number.isFinite(previousTotalKw)
  )
    ? roundOvershootKw(context.total - previousTotalKw)
    : null;
  const attributedDeltaKw = roundOvershootKw(contributors.reduce((sum, contributor) => sum + contributor.deltaKw, 0));
  const unattributedDeltaKw = totalDeltaKw === null ? null : roundOvershootKw(totalDeltaKw - attributedDeltaKw);
  const attributionReason = resolveOvershootAttributionReason({
    contributors,
    totalDeltaKw,
    hasPriorPlanBaseline: previousBuiltAtMs !== null || Object.keys(previousDevicesById).length > 0,
    // A confident cause may only be emitted when the attribution inputs were both
    // FRESH and COMPLETE this cycle. Any uncertainty collapses to one honest
    // `attribution_inputs_incomplete` reason rather than a confident-but-wrong cause.
    attributionInputsComplete: areAttributionInputsComplete({
      powerFreshnessState: context.powerFreshnessState,
      totalDeltaKw,
      currentDevicesById,
      previousDevicesById,
    }),
  });

  return {
    totalDeltaKw,
    contributors,
    logFields: {
      overshootPlanAgeMs: (
        typeof previousBuiltAtMs === 'number' ? Math.max(0, nowTs - previousBuiltAtMs) : null
      ),
      overshootPowerSampleAgeMs: lastPowerUpdateMs !== null ? Math.max(0, nowTs - lastPowerUpdateMs) : null,
      overshootTotalDeltaKw: totalDeltaKw,
      overshootAttributionDeltaKw: attributedDeltaKw,
      overshootUnattributedDeltaKw: unattributedDeltaKw,
      overshootAttributionReason: attributionReason,
      overshootTopControlledContributors: controlled,
      overshootTopUncontrolledContributors: uncontrolled,
    },
  };
}

// When at least one managed device crossed the attribution epsilon, the contributor
// arrays already explain the overshoot, so no reason is emitted (null). Otherwise we
// classify why attribution is unavailable. A CONFIDENT cause
// (`background_load_dominant` / `all_deltas_below_epsilon`) is gated on a single
// completeness assessment; any uncertainty collapses to one honest
// `attribution_inputs_incomplete` reason. Every emitted value is provably true from
// the diff inputs in scope.
function resolveOvershootAttributionReason(params: {
  contributors: OvershootEntryContributor[];
  totalDeltaKw: number | null;
  hasPriorPlanBaseline: boolean;
  attributionInputsComplete: boolean;
}): OvershootAttributionReason | null {
  const {
    contributors,
    totalDeltaKw,
    hasPriorPlanBaseline,
    attributionInputsComplete,
  } = params;
  if (contributors.length > 0) return null;
  // Reserve `no_previous_snapshot` for a TRUE cold start (no prior plan baseline at
  // all). It is the only reason emitted when nothing could be diffed for a reason
  // other than incomplete/stale inputs.
  if (!hasPriorPlanBaseline) return 'no_previous_snapshot';
  // A confident cause requires fresh + complete + diffable inputs. Anything short of
  // that is one honest reason rather than a confident-but-wrong cause.
  if (!attributionInputsComplete) return 'attribution_inputs_incomplete';
  // Inputs are complete-and-fresh, so `totalDeltaKw` is a finite, trustworthy number
  // and the unattributed delta equals the total delta. Classify directly off it.
  if (totalDeltaKw !== null && totalDeltaKw > OVERSHOOT_DELTA_EPSILON_KW) {
    return 'background_load_dominant';
  }
  return 'all_deltas_below_epsilon';
}

// The SINGLE completeness gate behind a confident attribution verdict. Returns true
// only when every confident-cause precondition holds:
//  (a) the power sample is FRESH — verified via the freshness state, not merely that
//      totals are finite, so a stale cached total under `stale_fail_closed` (which
//      forces an actionable overshoot off an old `getLastTotalPower()`) never yields a
//      confident delta;
//  (b) a finite, diffable total delta exists (a fresh sample with a missing previous
//      total cannot be diffed); AND
//  (c) every tracked device that could PLAUSIBLY have carried the rise — controllable
//      OR uncontrolled, with a current reading above the attribution epsilon — was
//      diffable (both current and previous power resolvable).
// (a)+(b) guard the stale-total / missing-sample cases; (c) guards the undiffable
// managed-or-uncontrolled device and the zero-current newcomer (whose 0/off current
// read could not have caused the rise, so its undiffability is harmless).
function areAttributionInputsComplete(params: {
  powerFreshnessState: PlanContext['powerFreshnessState'];
  totalDeltaKw: number | null;
  currentDevicesById: Record<string, OvershootTrackedPlanDevice>;
  previousDevicesById: Record<string, OvershootTrackedPlanDevice>;
}): boolean {
  const { powerFreshnessState, totalDeltaKw, currentDevicesById, previousDevicesById } = params;
  if (powerFreshnessState !== 'fresh') return false;
  if (totalDeltaKw === null) return false;
  return !hasUndiffablePlausibleContributor(currentDevicesById, previousDevicesById);
}

// True when at least one tracked device that could PLAUSIBLY have carried the rise was
// DROPPED from the contributor diff because it could not be diffed — its current read
// was unresolvable, or its previous-snapshot power was missing/unknown (e.g. a newly
// discovered device, or a prior stale-hold cycle). A device whose CURRENT reading sits
// at/below the attribution epsilon (off / ~0 W) cannot have caused a positive rise, so
// its undiffability is harmless and does not block a confident verdict — this covers
// the zero-current newcomer. Controllable AND uncontrolled tracked devices count: an
// undiffable uncontrolled device is just as capable of being the real cause.
function hasUndiffablePlausibleContributor(
  currentDevicesById: Record<string, OvershootTrackedPlanDevice>,
  previousDevicesById: Record<string, OvershootTrackedPlanDevice>,
): boolean {
  return Object.values(currentDevicesById).some((device) => {
    const currentKw = resolveOvershootDevicePower(device).kw;
    // A device reading at/below the epsilon (off or ~0 W) could not have caused the
    // rise; its undiffability is harmless. Only an unresolvable OR above-epsilon
    // current reading makes the device a plausible-but-undiffable contributor.
    if (currentKw !== null && currentKw <= OVERSHOOT_DELTA_EPSILON_KW) return false;
    const previousKw = resolveOvershootDevicePower(previousDevicesById[device.id]).kw;
    return currentKw === null || previousKw === null;
  });
}

function buildOvershootContributor(
  device: OvershootTrackedPlanDevice,
  previous: OvershootTrackedPlanDevice | undefined,
): OvershootEntryContributor | null {
  const nextPower = resolveOvershootDevicePower(device);
  const previousPower = resolveOvershootDevicePower(previous);
  if (nextPower.kw === null || previousPower.kw === null) return null;
  const deltaKw = nextPower.kw - previousPower.kw;
  if (deltaKw <= OVERSHOOT_DELTA_EPSILON_KW) return null;
  const expectedPowerKw = resolveFiniteNumber(device.expectedPowerKw);
  const measuredPowerKw = resolveFiniteNumber(device.measuredPowerKw);
  let expectedByPreviousPlan: boolean | null = null;
  if (previous && previous.controllable !== false) {
    expectedByPreviousPlan = previous.plannedState !== 'shed' && previous.plannedState !== 'inactive';
  }

  return {
    deviceId: device.id,
    deviceName: device.name,
    deltaKw: roundOvershootKw(deltaKw),
    previousPowerSource: previousPower.source,
    newPowerSource: nextPower.source,
    controllable: device.controllable !== false,
    expectedByPreviousPlan,
    changedDuringPendingWindow: hasPendingWindow(previous) || hasPendingWindow(device),
    changedDuringCooldownWindow: isCooldownBlocked(previous) || isCooldownBlocked(device),
    measuredExceedsExpectedKw: (
      measuredPowerKw !== null && expectedPowerKw !== null && measuredPowerKw > expectedPowerKw
    )
      ? roundOvershootKw(measuredPowerKw - expectedPowerKw)
      : null,
  };
}

function trackPlanDeviceForOvershoot(
  device: DevicePlanDevice,
  state: PlanEngineState,
  pendingBinaryCommandStore: PendingBinaryCommandStore,
): OvershootTrackedPlanDevice {
  // Raw read: activeness is computed below with the device's
  // communication model, so `peek` (not `get`) preserves the prior
  // field-read semantics without triggering store eviction here.
  const pendingBinaryCommand = pendingBinaryCommandStore.peek(device.id);
  const pendingBinaryCommandActive = isPendingBinaryCommandActive({
    pending: pendingBinaryCommand,
    communicationModel: device.communicationModel,
  });
  return {
    id: device.id,
    name: device.name,
    controllable: device.controllable,
    plannedState: device.plannedState,
    currentState: device.currentState,
    // Source the binary on/off truth only when the device is binary this cycle (a
    // transient capability drop revokes binary status; see `isBinaryPlanDevice`).
    // `currentOn` is the resolved on/off truth used for overshoot power.
    ...(isBinaryPlanDevice(device)
      ? { currentOn: device.currentOn }
      : {}),
    measuredPowerKw: device.measuredPowerKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: device.planningPowerKw,
    observationStale: device.observationStale,
    binaryCommandPending: pendingBinaryCommandActive && pendingBinaryCommand?.desired === true,
    pendingBinaryOnCommand: pendingBinaryCommandActive && pendingBinaryCommand?.desired === true,
    pendingBinaryOffCommand: pendingBinaryCommandActive && pendingBinaryCommand?.desired === false,
    stepCommandPending: device.stepCommandPending,
    reason: device.reason,
    pendingTargetCommand: shouldExposePendingTargetCommand(device, state),
  };
}

function trackPlanDevicesForOvershoot(
  planDevices: DevicePlanDevice[],
  state: PlanEngineState,
  pendingBinaryCommandStore: PendingBinaryCommandStore,
): Record<string, OvershootTrackedPlanDevice> {
  return Object.fromEntries(
    planDevices.map((device) => [
      device.id,
      trackPlanDeviceForOvershoot(device, state, pendingBinaryCommandStore),
    ]),
  );
}

function shouldExposePendingTargetCommand(
  device: DevicePlanDevice,
  state: PlanEngineState,
): boolean {
  const pending = state.pendingTargetCommands[device.id];
  const isTemperature = isTemperaturePlanDevice(device);
  const currentTarget = isTemperature ? device.currentTarget : null;
  const plannedTarget = isTemperature ? device.plannedTarget : undefined;
  return Boolean(
    pending
    && typeof plannedTarget === 'number'
    && plannedTarget !== currentTarget
    && plannedTarget === pending.desired,
  );
}

function resolveOvershootDevicePower(
  device: Pick<
    OvershootTrackedPlanDevice,
    'currentOn' | 'currentState' | 'measuredPowerKw' | 'expectedPowerKw' | 'planningPowerKw'
  > | undefined,
): { kw: number | null; source: ResolvedPowerSource } {
  if (!device) return { kw: null, source: 'unknown' };
  const measuredPowerKw = resolveFiniteNumber(device.measuredPowerKw);
  if (measuredPowerKw !== null) return { kw: measuredPowerKw, source: 'measured' };
  // A confirmed-off device draws nothing. `currentOn === false` is the binary
  // off truth; a step-only stepper carries no `currentOn`, so its off-state is
  // the producer-resolved step-axis label `currentState === 'off'`.
  if (device.currentOn === false || device.currentState === 'off') return { kw: 0, source: 'off' };
  const expectedPowerKw = resolveFiniteNumber(device.expectedPowerKw);
  if (expectedPowerKw !== null) return { kw: expectedPowerKw, source: 'expected' };
  const planningPowerKw = resolveFiniteNumber(device.planningPowerKw);
  if (planningPowerKw !== null) return { kw: planningPowerKw, source: 'planning' };
  return { kw: null, source: 'unknown' };
}

function hasPendingWindow(
  device: {
    pendingBinaryOnCommand?: boolean;
    pendingBinaryOffCommand?: boolean;
    binaryCommandPending?: boolean;
    stepCommandPending?: boolean;
    pendingTargetCommand?: boolean | DevicePlanDevice['pendingTargetCommand'];
  } | undefined,
): boolean {
  if (!device) return false;
  return device.pendingBinaryOnCommand === true
    || device.pendingBinaryOffCommand === true
    || device.stepCommandPending === true
    || Boolean(device.pendingTargetCommand);
}

function isCooldownBlocked(
  device: Pick<OvershootTrackedPlanDevice, 'reason'> | undefined,
): boolean {
  if (!device) return false;
  return isCooldownReason(device.reason);
}

function isCooldownReason(reason: DeviceReason): boolean {
  return isCooldownBlockedReason(reason);
}

function resolveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? roundOvershootKw(value)
    : null;
}

function roundOvershootKw(value: number): number {
  return Math.round(value * 100) / 100;
}

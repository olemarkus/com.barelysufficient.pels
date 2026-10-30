import type {
  DeferredObjectivePlanPreviewCandidate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type { DeferredObjectiveSettingsEntry } from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { SmartTaskHomeScope } from '../../../packages/contracts/src/smartTaskHomeScope';
import type {
  MeasuredPowerObservedFields,
  MeasuredPowerObservedProbe,
} from '../../../packages/contracts/src/types';
import type { WidgetObjectiveWriteResult } from '../../../packages/contracts/src/widgetHostApi';
import { resolveObjectiveTargetValue } from '../../../packages/shared-domain/src/deferredObjectiveValues';
import {
  normalizeDeferredObjectiveSettingsEntry,
} from '../../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import {
  resolveSmartTaskGoalBounds,
  supportsSmartTaskKind,
  type SmartTaskDeviceLike,
} from '../../../packages/shared-domain/src/smartTaskDeviceKind';
import { asMeteredSnapshot } from '../../ports/meteredSnapshots';
import {
  gateCandidateExtraPermissions,
  readStoredObjectiveState,
  type GateDevice,
} from './limitGrantGate';
import type { ObjectiveSettingsStore } from './objectiveStore';

// The final check of every smart-task write (the widget create, the settings
// UI's create and edit, and the budget-exempt rescue): the device must be one
// the planner plans, in the Main home, able to take the goal kind, with a
// target inside its own range, and the entry must survive the canonical
// normalizer. The persistence operations keep their own write-time protections;
// this decides what reaches them.

/** What the check reads of a device: its goal surfaces, the permission gate's facts, and its measured power. */
export type SmartTaskWriteDevice = SmartTaskDeviceLike & GateDevice & MeasuredPowerObservedProbe;

/**
 * The owner reads the check runs on, resolved by their owners and bound by
 * `setup/`. Read lazily and in order, so a refused device never costs the
 * later reads.
 */
export type SmartTaskWriteReads<Device extends SmartTaskWriteDevice> = {
  /** The device in the runtime plan input, or `undefined` when it is not there. */
  findPlanInputDevice(deviceId: string): Device | undefined;
  /** The planner's own planned-set rule, so the write and the planner agree on which devices it plans. */
  isRuntimePlanned(device: Device & MeasuredPowerObservedFields): boolean;
  /** Whether the settings-UI device picker lists the device. */
  isPickerDevice(deviceId: string): boolean;
  /** The device's Main-home scope from the membership owner. */
  resolveHomeScope(deviceId: string): SmartTaskHomeScope;
  /** The stored tasks, for the permission gate's standing-grant read. */
  store: ObjectiveSettingsStore;
};

/**
 * Durable scope reasons stay typed; transient refusals collapse to the
 * retryable `write_refused`. Deliberately not named `SmartTaskWriteRejectReason`:
 * the settings-UI edit lane has its own differently-shaped union of that name in
 * `packages/contracts/src/smartTaskEdit.ts`, and two same-named unions are an
 * auto-import trap.
 */
type WriteRejectReason = Extract<WidgetObjectiveWriteResult, { ok: false }>['reason'];

export type ValidatedSmartTaskWrite<Device extends SmartTaskWriteDevice> =
  | { ok: true; device: Device & MeasuredPowerObservedFields; entry: DeferredObjectiveSettingsEntry }
  | { ok: false; reason: WriteRejectReason };

/**
 * Resolve a write candidate against the runtime-planned device, its goal kind
 * and its actual setpoint range, then normalise it. Returns the validated
 * device and entry, or a stable rejection reason.
 */
export const validateSmartTaskWrite = <Device extends SmartTaskWriteDevice>(
  reads: SmartTaskWriteReads<Device>,
  deviceId: string,
  candidate: DeferredObjectivePlanPreviewCandidate,
): ValidatedSmartTaskWrite<Device> => {
  // Persist ONLY against the runtime-planned snapshot — see PLANNED-SET
  // HONESTY on `AppSmartTaskApi.createDeferredObjective`. A device that exists
  // in the picker but not here, OR that is in the runtime snapshot but
  // `managed: false` (so the planner's `isRuntimePlannedDevice` filter drops
  // it — possible when the managed filter is inactive), is reported as
  // `device_not_planned`, not silently persisted. Uses the SAME predicate the
  // plan service and the candidate listing use so the three never diverge.
  const device = reads.findPlanInputDevice(deviceId);
  const meteredDevice = device && asMeteredSnapshot(device);
  if (!meteredDevice || !reads.isRuntimePlanned(meteredDevice)) {
    const inPickerOrSnapshot = device !== undefined || reads.isPickerDevice(deviceId);
    return { ok: false, reason: inPickerOrSnapshot ? 'device_not_planned' : 'device_not_found' };
  }
  // Multi-home v1 scope: a sub-home device is rejected with its own honest
  // reason BEFORE kind/bounds validation — the admission math is main-only,
  // so the task would be planned against the wrong meter's budget. Mirrors
  // the candidate-list exclusion and the write-op gate so the three can
  // never disagree.
  const homeScope = reads.resolveHomeScope(deviceId);
  if (homeScope === 'sub_home') return { ok: false, reason: 'device_in_sub_home' };
  if (homeScope === 'source_device') return { ok: false, reason: 'device_not_planned' };
  if (homeScope === 'unavailable') return { ok: false, reason: 'write_refused' };
  // The device must support the goal kind the candidate claims — an EV-SoC
  // goal on a thermostat (or vice versa) is rejected before it can persist.
  if (!supportsSmartTaskKind(meteredDevice, candidate.kind)) {
    return { ok: false, reason: 'device_not_eligible' };
  }
  // Validate the target against the DEVICE's actual setpoint range, not just
  // the generic normalizer's -50..100 °C / 1..100 % envelope. This mirrors the
  // Flow-card `validateTargetTemperature` (which reads the device capability
  // min/max) and the picker bounds the widget itself offered, so the write
  // rejects an impossible target (e.g. 90 °C on a 30..75 °C heater) instead of
  // persisting one the device can never reach.
  const bounds = resolveSmartTaskGoalBounds(meteredDevice, candidate.kind);
  const targetValue = resolveObjectiveTargetValue(candidate);
  if (!Number.isFinite(targetValue) || targetValue < bounds.min || targetValue > bounds.max) {
    return { ok: false, reason: 'invalid_candidate' };
  }
  // Gate opt-in extra permissions against the resolved device before the entry
  // is normalised/persisted (drops an ineligible limit-lower-priority grant),
  // so a tampered or stale client can never persist a permission this device
  // can't honour. Matches the gate the preview applies.
  const gatedCandidate = gateCandidateExtraPermissions(
    meteredDevice,
    candidate,
    readStoredObjectiveState(reads.store, deviceId),
  );
  // Re-validate via the canonical normalizer with `enabled: true`; a creation
  // is implicitly an enabled objective. This rejects malformed deadlines and
  // the generic target envelope exactly as the Flow-card / settings paths do.
  const entry = normalizeDeferredObjectiveSettingsEntry(
    { ...gatedCandidate, enabled: true },
  );
  if (!entry) return { ok: false, reason: 'invalid_candidate' };
  return { ok: true, device: meteredDevice, entry };
};

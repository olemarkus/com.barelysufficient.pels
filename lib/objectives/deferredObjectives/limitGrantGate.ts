import type {
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
} from '../../../packages/contracts/src/types';
import { isSteppedLoadSnapshot } from '../../../packages/shared-domain/src/steppedLoadObservedState';
import { getDebugEmitter } from '../../logging/logger';
import {
  objectiveAbsenceIsTrustworthy,
  readObjectiveForDevice,
  type ObjectiveSettingsStore,
} from './objectiveStore';
import type {
  DeferredObjectivePlanPreviewCandidate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type { DeferredObjectiveSettingsEntry } from './settings';

const emitSmartTaskDebug = getDebugEmitter('smart-task-api', 'deferred_objectives');

/**
 * What the store says about a device's current objective: the entry when one
 * was read, and whether an absence can be trusted (a transient-empty key list
 * cannot be told from a device with no task).
 */
type StoredObjectiveState = {
  entry: DeferredObjectiveSettingsEntry | undefined;
  absenceTrustworthy: boolean;
};

type GateDevice = TargetDeviceSnapshot & SteppedLoadDescriptorProbe;

/** Read one device's objective for the gate; a thrown read is an untrusted absence. */
export const readStoredObjectiveState = (
  store: ObjectiveSettingsStore,
  deviceId: string,
): StoredObjectiveState => {
  try {
    const entry = readObjectiveForDevice(store, deviceId);
    return {
      entry,
      absenceTrustworthy: entry !== undefined || objectiveAbsenceIsTrustworthy(store, deviceId),
    };
  } catch {
    return { entry: undefined, absenceTrustworthy: false };
  }
};

// Only stepped-load devices (EV chargers + stepped thermal) can honour the
// `limitLowerPriorityDevices` rescue permission — it engages the device's boost,
// which the boost resolvers gate on the device's stepped-load profile
// (`resolveBoostSupported` → `hasSteppedLoadProfile`); a binary on/off device has
// no higher step to promote to.
const deviceSupportsLimitLowerPriority = (device: GateDevice): boolean => (
  device.controlModel === 'stepped_load' && isSteppedLoadSnapshot(device)
);

// A grant we can't rule out counts as established: an unreadable store is
// the same class of transient as a half-warmed device snapshot, so treating
// its silence as "nothing stands" would reintroduce the revocation this
// check exists to stop (`objectiveAbsenceIsTrustworthy` is the same guard
// the write ops use before acting on an absence).
const limitGrantStandsOrUnknown = (storedState: StoredObjectiveState): boolean => {
  const stored = storedState.entry;
  return stored === undefined
    ? !storedState.absenceTrustworthy
    : stored.rescue?.limitLowerPriorityDevices !== undefined;
};

/**
 * Gate a smart-task candidate's opt-in "Extra permissions" against the device
 * BEFORE it is previewed or persisted — defence-in-depth, since a client's
 * toggle visibility is not trusted. Runs on the preview and the write lane
 * alike, so preview ≡ persist.
 *
 * Only `limitLowerPriorityDevices` is gated; `exemptFromBudget` and
 * `pauseLowerPriorityDevices` are ungated (any device can exceed the soft daily
 * budget, and the startup reservation is priority-relative by construction). A
 * NEW limit grant is dropped when the device is not stepped-load eligible. It is
 * NOT paired with `exemptFromBudget`: the runtime honours the limit grant alone
 * (`limitLowerPriorityApplied` keys on it alone, `freshDiagnostic.ts`), and the
 * Flow card writes limit-only grants verbatim.
 *
 * NOT gated on `priority === 1`. That conjunct belongs to the planner's
 * `fullyReserved` FLOOR PROMOTION (`rescueReplan.ts`), where it is load-bearing
 * because the reserved-headroom forecast (`hardCap − uncontrolled`) assumes
 * every controlled watt is displaceable — true only at the top. Persisting the
 * permission is a different question: limiting lower-priority devices helps at
 * any priority, because the two paths that actually take load off another
 * device both compare priority STRICTLY, against the same priority source
 * (`lib/plan/planDevices.ts`):
 *   - swap selection — `lib/plan/swap/candidates.ts` refuses any candidate with
 *     `onDevPriority <= devPriority`;
 *   - startup-reserve admission — `lib/plan/admission/headroomReserve.ts` only
 *     withholds power from devices with `reserve.priority < devPriority`.
 * So a boosted priority-2 device can never command a priority-1 device or a
 * peer off. (Narrower than "the planner is priority-safe": the boost bypasses
 * in `lib/plan/restore/steppedRestoreAdmission.ts` and `planSteppedLoad.ts` are
 * priority-BLIND, so a boosted low-priority device can out-compete a shed
 * higher-priority one for headroom. That is pre-existing and equally reachable
 * via any user-configured device boost — but do not read this comment as
 * claiming otherwise.)
 *
 * The gate WITHHOLDS a grant the caller is newly asking for; it must never
 * ERASE one the device already holds. The settings-UI edit lane writes with
 * `rescue: 'replace'`, and the eligibility test reads `controlModel`, which is
 * re-derived from live device reads (`lib/device/managerNativeEv.ts`) and is
 * absent for an auto-native-wired stepper during the post-restart window.
 * Without the standing check, one degraded read during an unrelated goal edit
 * would permanently revoke an effective permission: the
 * destructive-reset-on-a-transient-read pattern
 * `notes/persisted-settings-state.md` exists to prevent.
 */
export const gateCandidateExtraPermissions = (
  device: GateDevice | undefined,
  candidate: DeferredObjectivePlanPreviewCandidate,
  storedState: StoredObjectiveState,
): DeferredObjectivePlanPreviewCandidate => {
  const rescue = candidate.rescue;
  if (!rescue?.limitLowerPriorityDevices) return candidate;
  if (limitGrantStandsOrUnknown(storedState)) return candidate;
  if (device !== undefined && deviceSupportsLimitLowerPriority(device)) return candidate;
  // A withheld grant is otherwise invisible: the write succeeds, the task looks
  // created, and the device simply never gets the priority it was promised.
  // Name the failing conjunct so a log review can tell "binary device" from
  // "device not in the snapshot" without re-deriving the gate. Debug, not info:
  // the rescue requests the grant for EVERY device, so on the binary devices
  // that dominate the starved set this is the normal path.
  emitSmartTaskDebug({
    event: 'smart_task_permission_withheld',
    permission: 'limitLowerPriorityDevices',
    reason: device === undefined ? 'device_unknown' : 'not_stepped_load',
    deviceId: device?.id ?? null,
    deviceName: device?.name ?? null,
  });
  const { limitLowerPriorityDevices: _dropped, ...keptRescue } = rescue;
  return {
    ...candidate,
    rescue: Object.keys(keptRescue).length > 0 ? keptRescue : undefined,
  };
};

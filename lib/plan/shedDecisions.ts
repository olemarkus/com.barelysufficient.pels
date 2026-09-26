import type { DevicePlanDevice } from './planTypes';
import type { DeferredDecorationBundle } from '../../packages/planner-types/src/deferredDecoration';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import { isBinaryPlanDevice } from './planBinaryDevice';
import { isPlanDeviceObservedOn, isSteppedLoadDevice } from './planSteppedLoad';
import { isRestoreAdmissionHoldReason, isSwapTargetPendingReason } from '../planContract/planDecisionSemantics';

/**
 * Which baseline-of-off posture(s) earned a device's shed-decision stamp
 * (`ShedDecisions.surplusOnlyByDevice`).
 */
export type BaselineOffPosture = {
  /** "Run on solar surplus": the producer-resolved `surplusOnly` posture. */
  surplus: boolean;
  /** "Only PELS starts this device", in force (`startPolicyInForce`). */
  startPolicy: boolean;
};

/**
 * What the plan decided to hold shed, and under which posture — the
 * decision-side record, as opposed to the actuation-time clocks in
 * `ActuationRecord`. One per `PlanEngineState`. In-memory: after a restart
 * there is no prior plan to diff. An off device goes through start admission
 * unless the previous plan kept it with command authority; after the first plan,
 * devices missing from its membership start in shed posture and must pass
 * planner admission before the plan can keep them.
 *
 * Every fact here is membership, never a time. Each question asked of the
 * record is "does PELS hold this device off NOW", and a set answers that with
 * nothing to go stale. The record used to carry a per-device decision clock
 * too, edge-set when a device entered the shed set; an ordinary restore never
 * cleared it, so "has a decision time" drifted into "was shed at some point
 * since boot" — and the restore lane that read it turned a water heater back on
 * that its owner's Flow had just switched off, from a shed PELS had undone four
 * hours earlier.
 *
 * Three writers. The planner authors the record at plan finalization
 * (`planBuilder`, and the silent-meter pass) and drops the posture stamp of a
 * device whose posture dropped (`planBuilderSurplus`); the executor reports
 * every turn-on it confirms (`noteShedReleased`). That executor write, and its
 * read of `standingShedIds` in the release lane, are a cross-layer edge the
 * planner/executor seam train is meant to remove: the planner should decide
 * the release and hand it over on the plan.
 */
export class ShedDecisions {
  /**
   * Baseline-off posture stamp: present for a device whose CURRENT shed
   * decision was taken while it carried a baseline-of-off posture — the
   * producer-resolved `surplusOnly` dump-load posture, or "Only PELS starts
   * this device" in force — and naming which. Refreshed for every planned-shed
   * device each build, so a posture toggle while held updates it. Its one
   * reader is the release (`releaseAbandonedSurplusPosture`), which drops the
   * stamp whenever the posture drops, and judges it against the owner setting
   * that earned it to decide whether the owner withdrew it: a start policy that
   * stopped applying because power limiting came on is not a withdrawal, a
   * cleared "Run on solar surplus" is, and one device can carry the first while
   * losing the second.
   */
  surplusOnlyByDevice: Record<string, BaselineOffPosture> = {};

  /**
   * The previous plan's shed set. Read by the hold-reason pass ("was this
   * device shed last build"), by plan materialization, which forwards it as
   * `wasShedLastBuild`, by restore admission (`wasShedOrUnplanned`), and by the
   * stepped-shed recovery rule (`isNonSteppedDeviceRecovering`).
   */
  lastPlannedShedIds: ReadonlySet<string> = new Set<string>();

  /**
   * The on/off devices PELS turned off and has not seen on since: the ones it
   * turns on itself if the owner takes its authority over the device away, so
   * turning Power-limit control off never strands a device off under a limit
   * nobody enforces any more (`applyUncontrolledBinaryRestore`, which serves
   * binary, non-stepped devices only).
   *
   * A device enters whenever the plan's shed switches it off while it is
   * observed ON (`plannedShedTargetKind: 'binary_off'`) and PELS is actuating,
   * so PELS's own shed is what turns it off. A device that was already off
   * when the plan held it (off at the owner's hand, and not resumed for want
   * of room) never enters, and nor does one shed by lowering its setpoint or
   * one held in Simulation mode, where nothing is written: letting go of any of
   * them is no reason to start it.
   *
   * It stays until the device is observed on again, whatever happens
   * meanwhile: PELS deciding to resume it (until the resume lands), an outage,
   * or the owner taking PELS's authority away. So a turn-on that failed is
   * retried. Observed on while PELS's own turn-off is still in flight is not
   * on, and a missing on/off reading is not evidence the device came on. It
   * leaves the moment the executor confirms any turn-on (`noteShedReleased`),
   * so an owner who switches a resumed device off again before the next build
   * is not overruled, and when the device leaves the plan.
   *
   * In-memory, like the rest of the record: a restart forgets it, so a device
   * PELS switched off before a restart is not switched back on if the owner
   * takes PELS's authority away before PELS resumes it.
   *
   * Two kinds of shed never enter and never stay, because the device is off
   * for someone else's reason and PELS letting go of it is no reason to start
   * it:
   * - a baseline-off posture: a surplus dump load or a "PELS starts it" device
   *   is off because its owner set a baseline of off. This set is the whole of
   *   the "never force a dump load on" rule; the release lane checks it before
   *   it writes anything.
   * - a shed PELS made under authority a smart task lent it
   *   (`lentAuthorityDeviceIds`): the task's own lifecycle clock owns what
   *   happens when it lets go. A device with authority of its own stays PELS's
   *   to undo, task or not.
   */
  standingShedIds: ReadonlySet<string> = new Set<string>();

  /** Whether a non-empty plan has established membership history; sticky across empty snapshots. */
  hasRecordedPlan = false;

  /**
   * The devices the previous plan kept while it held command authority over
   * them: PELS decided they should run. An off device outside this set (left
   * `inactive`, kept without authority, or with no plan yet) is turned on only
   * through admission (`restore/devices.ts`); one inside it is drift.
   */
  lastPlannedKeptIds: ReadonlySet<string> = new Set<string>();

  /** Every device represented by the previous plan, including planned keeps. */
  lastPlannedDeviceIds: ReadonlySet<string> = new Set<string>();

  get hasPlanHistory(): boolean {
    // A non-empty set is also sufficient evidence in focused domain fixtures
    // that seed the previous plan directly.
    return this.hasRecordedPlan || this.lastPlannedDeviceIds.size > 0;
  }

  /**
   * A keep from the shed posture needs capacity admission. Once a prior plan
   * exists, a device absent from it starts in that same posture. An observed-off
   * device the previous plan did not keep with authority is admitted too
   * (`lastPlannedKeptIds`, read in `restore/devices.ts`).
   */
  wasShedOrUnplanned(deviceId: string): boolean {
    if (this.lastPlannedShedIds.has(deviceId)) return true;
    return this.hasPlanHistory && !this.lastPlannedDeviceIds.has(deviceId);
  }

  /**
   * Record one plan build's final shed and keep decisions, against the
   * decorated input the build planned from. The posture stamp is REFRESHED for
   * every currently planned-shed device, so toggling the posture off while
   * held clears it.
   */
  recordPlannedShed(
    planDevices: readonly DevicePlanDevice[],
    decoration: DeferredDecorationBundle,
    pendingBinaryCommands: PendingBinaryCommandStore,
    actuating: boolean,
  ): void {
    const devices = decoration.admittedDevices;
    const shedIds = planDevices.filter((device) => device.plannedState === 'shed').map(({ id }) => id);
    // EITHER baseline-off posture earns the stamp and keeps the shed out of
    // `standingShedIds`: "I am off because my owner configured a baseline of
    // off" is the same fact whether the posture is "Run on solar surplus" or
    // "Only PELS starts this device". Without the second arm, clearing the
    // start policy turned the device ON as PELS's last act before giving up
    // the lever.
    const postureById = new Map<string, BaselineOffPosture>();
    for (const device of devices) {
      const posture = {
        surplus: device.surplusOnly === true,
        startPolicy: device.startPolicyInForce === 'pels_only',
      };
      if (posture.surplus || posture.startPolicy) postureById.set(device.id, posture);
    }
    for (const id of shedIds) {
      const posture = postureById.get(id);
      if (posture) {
        this.surplusOnlyByDevice[id] = posture;
      } else {
        delete this.surplusOnlyByDevice[id];
      }
    }
    this.standingShedIds = new Set(planDevices
      .filter((device) => !isSteppedLoadDevice(device)
        && !postureById.has(device.id) && !decoration.lentAuthorityDeviceIds.has(device.id))
      .filter((device) => (actuating && isShedSwitchingOff(device))
        || (this.standingShedIds.has(device.id)
          && (!isPlanDeviceObservedOn(device) || pendingBinaryCommands.hasActiveTurnOff(device.id))))
      .map(({ id }) => id));
    this.lastPlannedShedIds = new Set(shedIds);
    this.lastPlannedKeptIds = new Set(planDevices
      .filter((device) => device.plannedState === 'keep' && device.control.commandAuthority)
      .map(({ id }) => id));
    this.lastPlannedDeviceIds = new Set(devices.map(({ id }) => id));
    if (devices.length > 0) this.hasRecordedPlan = true;
  }

  /** The posture this stamp records dropped; the device is plainly managed again. */
  clearPostureStamp(deviceId: string): void {
    delete this.surplusOnlyByDevice[deviceId];
  }

  /** PELS turned the device on (a resume, or the release as it let go): any shed is undone. */
  noteShedReleased(deviceId: string): void {
    if (!this.standingShedIds.has(deviceId)) return;
    this.standingShedIds = new Set([...this.standingShedIds].filter((id) => id !== deviceId));
  }
}

/**
 * This plan's shed switches the device off while it is on: PELS's own
 * turn-off. The same test the executor's projection applies before it builds
 * the off command (`buildExecutableBinaryShedIntent`): a shed held for a swap
 * target not yet known, or a restore the planner declined (which marks an off
 * device `shed` without deciding to switch anything), issues nothing. The
 * projection may not be imported here, so the rule is restated beside it.
 */
const isShedSwitchingOff = (device: DevicePlanDevice): boolean => (
  device.plannedShedTargetKind === 'binary_off' && isBinaryPlanDevice(device) && device.currentOn
  && !isSwapTargetPendingReason(device.reason) && !isRestoreAdmissionHoldReason(device.reason)
);

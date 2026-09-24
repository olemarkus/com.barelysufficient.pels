import type { DevicePlanDevice, PlanInputDevice } from './planTypes';

/**
 * What the plan decided to hold shed, when, and under which posture — the
 * decision-time record, as opposed to the actuation-time clocks in
 * `ActuationRecord`. One per `PlanEngineState`. In-memory: after a restart
 * there is no prior plan to diff. An off device goes through start admission
 * unless the previous plan kept it with command authority; after the first plan,
 * devices missing from its membership start in shed posture and must pass
 * planner admission before the plan can keep them.
 *
 * Four writers, and not all of them are the planner. The planner authors the
 * record at plan finalization (`planBuilder`, and the silent-meter pass) and
 * releases a device whose surplus posture it has abandoned
 * (`planBuilderSurplus`); the executor drops the claim in its two
 * capacity-control-off restore lanes (`planExecutor`, `binaryControlShared`).
 * That executor write is decision-level rather than actuation-level, so it is
 * a cross-layer edge the planner/executor seam train is meant to remove — the
 * executor should report the release and let the planner record it.
 *
 * The distinction from `ActuationRecord.lastDeviceShedMs` is the point: a
 * device the plan decided to shed but that was already off has no actuation
 * stamp, because the executor skipped the write. This record has it, which is
 * why the restore-eligibility readers consult this one.
 */
export class ShedDecisions {
  /**
   * When the planner decided each device should be held shed. Edge-set at
   * plan finalization for every device entering the FINAL shed set — which
   * `planBuilderSurplus` has already merged the solar dump-load holds and the
   * deferred force-sheds into, so a solar-held device is stamped too. Entry is
   * what counts, not actuation: a decided-but-already-off device is recorded
   * even when the executor skips the write. Cleared where the claim is released:
   * controlled restores age it out via the `lastDeviceRestoreMs` comparison,
   * uncontrolled `capacity_control_off` restores delete it, and an abandoned
   * surplus posture drops it. This decision time feeds recovery,
   * stepped-restore blocking, and the uncontrolled-restore stability gate.
   * Planned-shed membership is the separate fact in `lastPlannedShedIds`; a
   * write-skipped shed still gets its decision time so these age-based gates
   * do not let it restore early. Once a prior plan exists, restore admission
   * also treats devices missing from `lastPlannedDeviceIds` as starting in
   * shed posture. See
   * `notes/state-management/deferred-objective-lifecycle-carveout.md`.
   */
  decidedMs: Record<string, number> = {};

  /**
   * Plan-less-safe "Run on solar surplus" posture stamp: `true` for a device
   * whose CURRENT shed decision was taken while it carried the
   * producer-resolved `surplusOnly` dump-load posture. Refreshed for every
   * planned-shed device each build, so a posture toggle while held updates it,
   * and cleared with the decision clock. The executor's
   * capacity-control-off/uncontrolled binary restore lanes consult THIS stamp
   * — never the plan device — so turning capacity control off (or unmanaging)
   * can never force-turn-ON a baseline-off dump load, even from a cold or
   * absent plan. A restart drops the stamp and the decision together, and the
   * uncontrolled-restore lane requires the decision, so that race is fail-safe
   * (no stamp ⇒ no decision ⇒ no forced ON).
   */
  surplusOnlyByDevice: Record<string, true> = {};

  /**
   * The previous plan's shed set — what makes the decision clock edge-set
   * rather than refreshed. Two readers outside this record ask what it holds:
   * the hold-reason pass ("was this device shed last build") and plan
   * materialization, which forwards it as `wasShedLastBuild`.
   */
  lastPlannedShedIds: ReadonlySet<string> = new Set<string>();

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
   * Record one plan build's final shed and keep decisions. The decision clock is EDGE-SET on
   * the transition into the shed set, so a re-shed after a restore takes a
   * fresh decision time while a device held throughout keeps its original one.
   * The surplus stamp is REFRESHED for every currently planned-shed device, so
   * toggling the posture off while held clears it.
   */
  recordPlannedShed(
    planDevices: readonly DevicePlanDevice[],
    devices: readonly PlanInputDevice[],
    nowTs: number,
  ): void {
    const shedIds = planDevices.filter((device) => device.plannedState === 'shed').map(({ id }) => id);
    // EITHER baseline-off posture earns the stamp. The stamp's whole job is to
    // refuse the uncontrolled force-ON when the owner withdraws PELS's
    // authority, and "I am off because my owner configured a baseline of off" is
    // the same fact whether the posture is "Run on solar surplus" or "Only PELS
    // starts this device". Without the second arm, clearing the start policy
    // turned the device ON as PELS's last act before giving up the lever.
    const baselineOffIds = new Set<string>();
    for (const device of devices) {
      if (device.surplusOnly === true || device.startPolicy === 'pels_only') {
        baselineOffIds.add(device.id);
      }
    }
    for (const id of shedIds) {
      if (!this.lastPlannedShedIds.has(id)) {
        this.decidedMs[id] = nowTs;
      }
      if (baselineOffIds.has(id)) {
        this.surplusOnlyByDevice[id] = true;
      } else {
        delete this.surplusOnlyByDevice[id];
      }
    }
    this.lastPlannedShedIds = new Set(shedIds);
    this.lastPlannedKeptIds = new Set(planDevices
      .filter((device) => device.plannedState === 'keep' && device.control.commandAuthority)
      .map(({ id }) => id));
    this.lastPlannedDeviceIds = new Set(devices.map(({ id }) => id));
    if (devices.length > 0) this.hasRecordedPlan = true;
  }

  /**
   * Drop a device's decision, together with its surplus-posture stamp: the
   * stamp qualifies the decision, so they live and die together.
   */
  clearFor(deviceId: string): void {
    delete this.decidedMs[deviceId];
    delete this.surplusOnlyByDevice[deviceId];
  }
}

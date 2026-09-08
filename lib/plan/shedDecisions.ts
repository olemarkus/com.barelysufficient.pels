/** What `recordPlannedShed` needs of a device to tell whether its shed carries the surplus posture. */
type SurplusPostureDevice = { id: string; surplusOnly?: true };

/**
 * What the plan decided to hold shed, when, and under which posture — the
 * decision-time record, as opposed to the actuation-time clocks in
 * `ActuationRecord`. One per `PlanEngineState`. In-memory: a restart drops the
 * whole record, which is the safe direction for the lane that reads it to
 * force a device ON — no decision on record means it does nothing.
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
   * surplus posture drops it. This is the intent/existence fact the
   * restore-eligibility readers consult — recovering, stepped-restore
   * blocking, restore-log source, and the uncontrolled-restore stability gate
   * — so a write-skipped shed no longer under-stamps and lets a device restore
   * early. See `notes/state-management/deferred-objective-lifecycle-carveout.md`.
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

  /**
   * Record one plan build's shed decisions. The decision clock is EDGE-SET on
   * the transition into the shed set, so a re-shed after a restore takes a
   * fresh decision time while a device held throughout keeps its original one.
   * The surplus stamp is REFRESHED for every currently planned-shed device, so
   * toggling the posture off while held clears it.
   */
  recordPlannedShed(
    shedIds: ReadonlySet<string>,
    devices: readonly SurplusPostureDevice[],
    nowTs: number,
  ): void {
    const surplusOnlyIds = new Set<string>();
    for (const device of devices) {
      if (device.surplusOnly === true) surplusOnlyIds.add(device.id);
    }
    for (const id of shedIds) {
      if (!this.lastPlannedShedIds.has(id)) {
        this.decidedMs[id] = nowTs;
      }
      if (surplusOnlyIds.has(id)) {
        this.surplusOnlyByDevice[id] = true;
      } else {
        delete this.surplusOnlyByDevice[id];
      }
    }
    this.lastPlannedShedIds = new Set(shedIds);
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

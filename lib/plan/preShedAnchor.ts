/**
 * Pre-shed setpoint anchor — the setpoint PELS owes a temperature device back.
 *
 * When the planner decides a setpoint shed (`set_temperature` behaviour), the
 * write that goes out lowers the device FROM its live setpoint TO the
 * configured shed floor. For a device with no configured mode target the live
 * setpoint is the only record of what it was lowered from — and once the shed
 * write lands, that record is gone: the release cycle's fallback seed
 * (`resolveTemperatureSeed`) reads the shed floor back as the "intended"
 * target, the executor sees desired === observed, and the resume never
 * happens. The anchor captures the pre-shed setpoint at decision time so the
 * release write has a real target, and so mode-target seeding
 * (`seedMissingModeTargets` in `setup/appDeviceSupport.ts`) can never record a
 * shed floor as the permanent mode target.
 *
 * The store PORT is declared here (domain); the persisted adapter lives in
 * `setup/preShedAnchorStoreAdapter.ts` (the settings seam — `no-lib-to-setup`
 * keeps the direction one-way). Persistence is the point: PELS restarts
 * routinely (including OOM kills), and both consumers must survive one —
 * post-restart seeding must not adopt the shed floor, and a post-restart
 * release must still know the real target.
 *
 * Lifecycle (all planner-owned, see `maintainPreShedAnchors`):
 * - CAPTURE on the first setpoint-shed-posture build that still observes an
 *   off-floor setpoint — the value taken before the floor write lands. This
 *   covers a fresh shed decision (captured on the deciding build), a re-shed
 *   after a settled release, AND a shed whose behaviour flips to
 *   `set_temperature` mid-hold (no shed-set edge fires there). Never
 *   overwrites a live anchor, and an already-at-floor first sight (restart,
 *   upgrade) is skipped — there is no debt left to read.
 * - CONSUME while the device sits AT its captured shed floor (the release
 *   write is still owed). The moment the observed setpoint is anywhere else,
 *   the live value is the truth again, so a manual change after release is
 *   respected instead of reverted.
 * - CLEAR once the device is released and its observed setpoint left the
 *   floor — whether it converged onto the anchor or a person moved it
 *   elsewhere, the debt is settled.
 */
import type { DevicePlanDevice } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';

export type PreShedAnchorEntry = {
  /** The setpoint the shed lowered FROM (°C) — the release target. */
  anchorC: number;
  /** The configured shed floor (°C) at decision time, pinned so release-pending
   * detection is immune to a mid-episode shed-behaviour edit. */
  shedFloorC: number;
};

/**
 * Per-device read result. `unavailable` is the persisted adapter's transient
 * boot-read failure state (abandon-grace window, see the adapter): consumers
 * treat it as "decide nothing" — the planner seeds from the live value as if
 * no anchor existed, seeding skips the device until a later pass, and anchor
 * maintenance neither captures nor clears. The in-memory store never
 * produces it.
 */
export type PreShedAnchorRead =
  | { kind: 'anchored'; entry: PreShedAnchorEntry }
  | { kind: 'none' }
  | { kind: 'unavailable' };

/**
 * A read the consumer has already settled its grace policy on:
 * `resolveAnchoredSetpoint` deliberately does NOT accept `unavailable`, so
 * every consumer states at its own call site what a transient adapter grace
 * means for it (the planner seed falls back to the live setpoint; seeding
 * skips the device and retries next pass) — a future consumer cannot silently
 * inherit another's policy.
 */
export type SettledPreShedAnchorRead = Exclude<PreShedAnchorRead, { kind: 'unavailable' }>;

export type PreShedAnchorStore = {
  read: (deviceId: string) => PreShedAnchorRead;
  /**
   * While `read` answers `unavailable`, a `record` is a DEFERRED
   * record-if-absent: the persisted adapter queues it and applies it only if
   * the store later loads without an entry for that device — so a capture
   * decided during the boot-read grace is not lost, and a recovered persisted
   * anchor is never clobbered by it. When reads answer normally, `record`
   * overwrites.
   */
  record: (deviceId: string, entry: PreShedAnchorEntry) => void;
  clear: (deviceId: string) => void;
  /**
   * One bounded attempt to land a previously-failed persist, called once per
   * plan rebuild by the maintenance pass. Reads stay write-free by rule, and
   * the next mutation may be hours away (often the release-clear itself), so
   * without this hook a transiently-failed capture write could sit
   * memory-only until the next OOM kill. No-op while clean, unavailable, or
   * for stores without persistence (the in-memory one).
   */
  retryDirtyPersist: () => void;
};

/** The read-only slice mode-target seeding consumes. */
export type PreShedAnchorReader = Pick<PreShedAnchorStore, 'read'>;

/**
 * The one consumption gate, shared by the planner seed and mode-target
 * seeding: the anchor speaks only while the device's observed setpoint sits
 * AT a shed floor — the observed value IS the shed value there, so falling
 * back to it would strand the device. Anywhere else (release landed, or a
 * person moved it) the live value is the truth again, so a manual change is
 * respected instead of reverted.
 *
 * "At a shed floor" is transition-proof: it matches the anchor's PINNED floor
 * or any of `configuredFloorsC` — the current build's capability-normalized
 * configured floor(s) for the device (empty where the caller has none to
 * offer). The pin is re-pointed only once the device is OBSERVED at an edited
 * floor (`maintainHeldDeviceAnchor`), and maintenance runs AFTER seed
 * resolution — so in the one build where a floor edit's write lands together
 * with release headroom, the observed value equals the NEW floor while the
 * pin still names the old one. Pinned-floor-only recognition read that as a
 * manual move, released to the floor, and settled the debt: stranded at the
 * edited floor.
 */
export function resolveAnchoredSetpoint(
  read: SettledPreShedAnchorRead,
  observedSetpointC: number,
  configuredFloorsC: readonly number[],
): { kind: 'anchor'; value: number } | { kind: 'live' } {
  if (read.kind !== 'anchored') return { kind: 'live' };
  const parkedAtFloor = (
    observedSetpointC === read.entry.shedFloorC || configuredFloorsC.includes(observedSetpointC)
  ) && observedSetpointC !== read.entry.anchorC;
  return parkedAtFloor
    ? { kind: 'anchor', value: read.entry.anchorC }
    : { kind: 'live' };
}

/**
 * Plain in-memory store: the default for `PlanEngineState` construction, so
 * every test harness gets real anchor semantics without settings wiring.
 * Production wiring passes the persisted adapter instead
 * (`composePlanEngine` in `setup/appInit/createPlanEngine.ts`).
 */
export function createInMemoryPreShedAnchorStore(): PreShedAnchorStore {
  const entries: Record<string, PreShedAnchorEntry> = {};
  return {
    read: (deviceId) => {
      const entry = entries[deviceId];
      return entry === undefined ? { kind: 'none' } : { kind: 'anchored', entry };
    },
    record: (deviceId, entry) => {
      entries[deviceId] = entry;
    },
    clear: (deviceId) => {
      delete entries[deviceId];
    },
    retryDirtyPersist: () => undefined,
  };
}

/**
 * Maintain the anchor lifecycle over one finalized plan. Runs at plan
 * finalization, right after `recordPlannedShedDecisions` (which supplies the
 * shed-decision edge so the two stay on one definition of "entered the shed
 * set this build").
 *
 * A device absent from the plan (removed or unmanaged mid-episode) keeps its
 * entry untouched: a transient snapshot gap must not settle the debt, and a
 * later re-appearance resumes the lifecycle. A device removed for good leaks
 * one tiny entry — accepted; there is no reliable "gone forever" signal.
 */
export function maintainPreShedAnchors(params: {
  planDevices: readonly DevicePlanDevice[];
  anchors: PreShedAnchorStore;
  /** This build's capability-normalized configured floor per device — the
   * same map the hold lane stamps from, so settle's at-floor recognition and
   * the plan's own floor writes cannot disagree within a build. */
  normalizedShedFloorCByDevice: ReadonlyMap<string, number>;
  /** False on a dry-run build (`shouldApplyPlan` suppresses every write
   * there): a simulated shed must not persist an anchor — the lowering never
   * happens, and the debt it records could later "restore" a target the
   * owner changed during the simulation. Capture and the floor re-pin are
   * gated; settle/clear still runs, because it reacts to OBSERVATIONS —
   * real-world facts whether or not PELS is actuating. */
  captureEnabled: boolean;
}): void {
  const { planDevices, anchors, normalizedShedFloorCByDevice, captureEnabled } = params;
  // One bounded retry per rebuild for a persist that failed on its mutation:
  // the planner cadence is the only path guaranteed to run day and night,
  // and reads stay write-free by rule.
  anchors.retryDirtyPersist();
  for (const dev of planDevices) {
    if (!isTemperaturePlanDevice(dev)) continue;
    // Capacity control explicitly OFF (`controllable === false`, a settings
    // fact the plan device carries) is NOT a special clear: the device falls
    // through to the settle path below and clears only once an OBSERVATION
    // confirms the setpoint left the floor — exactly the released-device rule.
    // Clearing at the decision edge, while the device still reports the floor,
    // stranded it: the seed had already planned the anchored target, and if
    // that write failed (or the process died first) the next build had no
    // anchor and adopted the live floor. The stale-anchor concern the clear
    // existed for is still covered: the moment the owner's own retarget is
    // observed (off-floor), settle clears the debt.
    if (
      dev.plannedState === 'shed'
      && dev.shedAction === 'set_temperature'
      && typeof dev.shedTemperature === 'number'
    ) {
      if (captureEnabled) {
        maintainHeldDeviceAnchor({
          deviceId: dev.id,
          observedTargetC: dev.currentTarget,
          shedFloorC: dev.shedTemperature,
          anchors,
        });
      }
      continue; // Held in shed posture: the debt stands.
    }
    settleReleasedDeviceAnchor({
      deviceId: dev.id,
      observedTargetC: dev.currentTarget,
      configuredFloorsC: configuredFloorsFor(normalizedShedFloorCByDevice, dev.id),
      anchors,
    });
  }
}

/** The 0-or-1-element "floors this build configures for the device" list the
 * transition-proof gates consume (`resolveAnchoredSetpoint`). */
export function configuredFloorsFor(
  normalizedShedFloorCByDevice: ReadonlyMap<string, number>,
  deviceId: string,
): readonly number[] {
  const floorC = normalizedShedFloorCByDevice.get(deviceId);
  return floorC === undefined ? [] : [floorC];
}

/**
 * Held in setpoint-shed posture. Capture is POSTURE-based, not shed-set-edge
 * based: the first build that holds the device in `set_temperature` posture
 * while its observed setpoint is still off the floor records the debt. The
 * generic shed-set edge would miss a shed whose behaviour flips from
 * `turn_off` to `set_temperature` mid-hold — the device is already in the
 * shed set, so no edge fires on the first build that actually lowers the
 * setpoint. The off-floor gate doubles as the restart/upgrade guard: a device
 * first seen already AT its floor carries no readable debt, and capturing the
 * floor as the anchor would let the seeder label a shed floor
 * `pre_shed_anchor` — claiming a protection it never provided. Never
 * overwrites a live anchor, and an `unavailable` read still captures — the
 * store contract makes that a deferred record-if-absent, so a shed decided
 * during the boot-read grace is not silently lost.
 */
function maintainHeldDeviceAnchor(params: {
  deviceId: string;
  observedTargetC: number;
  shedFloorC: number;
  anchors: PreShedAnchorStore;
}): void {
  const { deviceId, observedTargetC, shedFloorC, anchors } = params;
  const held = anchors.read(deviceId);
  if (held.kind !== 'anchored') {
    if (observedTargetC !== shedFloorC) {
      anchors.record(deviceId, { anchorC: observedTargetC, shedFloorC });
    }
    return;
  }
  if (held.entry.shedFloorC !== shedFloorC && observedTargetC === shedFloorC) {
    // The owner edited the shed floor mid-hold. Re-pin only once the device
    // is OBSERVED at the new floor: until the executor's write to the new
    // floor lands, the device still reports the old one, and re-pinning
    // early would make the at-floor gate miss it — a release in that window
    // would then CLEAR the anchor while the device is still parked. With the
    // pin unchanged, a premature release still restores the anchor. The
    // anchor value itself (the debt) never changes while held.
    anchors.record(deviceId, { anchorC: held.entry.anchorC, shedFloorC });
  }
}

/**
 * Not in setpoint-shed posture. A live anchor settles the moment the released
 * device's observed setpoint is anywhere but the captured floor: it converged
 * onto the anchor, or a person/another app moved it — either way the live
 * value is the truth again. (A degenerate anchor whose value IS the floor
 * clears immediately: releasing it was always a no-op.)
 */
function settleReleasedDeviceAnchor(params: {
  deviceId: string;
  observedTargetC: number;
  /** This build's configured floor(s) — same recognition as the seed gate, so
   * a floor edit landing in a release-headroom build cannot read as a manual
   * move and clear the debt while the device is still parked. */
  configuredFloorsC: readonly number[];
  anchors: PreShedAnchorStore;
}): void {
  const { deviceId, observedTargetC, configuredFloorsC, anchors } = params;
  const read = anchors.read(deviceId);
  if (read.kind !== 'anchored') return;
  const stillParkedAtFloor = (
    observedTargetC === read.entry.shedFloorC || configuredFloorsC.includes(observedTargetC)
  ) && observedTargetC !== read.entry.anchorC;
  if (!stillParkedAtFloor) {
    anchors.clear(deviceId);
  }
}

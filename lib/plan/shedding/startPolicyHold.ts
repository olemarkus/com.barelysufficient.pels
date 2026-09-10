import type { PlanInputDevice } from '../planTypes';
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../../packages/shared-domain/src/planReasonSemantics';

/**
 * Standing hold for the `pels_only` start policy: "PELS decides when this runs."
 *
 * Ownership: this module — the single home for shedding selection
 * (`lib/plan/shedding/AGENTS.md`) — decides which devices are HELD OFF this
 * cycle by their owner's start policy. The policy itself is producer-resolved
 * onto `PlanInputDevice.startPolicy` at `toPlanDevice`; nothing here reads the
 * settings map.
 *
 * ## Why this is a plan posture and not an executor rule
 *
 * The behaviour the owner asked for is "a start nobody planned gets turned back
 * off". The tempting shape is to catch the start and react to it. The honest
 * shape is to give the device a standing OFF **intent**, because then nothing
 * new has to actuate: the executor's existing convergence already writes a
 * device whose observation disagrees with its plan, so an unplanned start is
 * ordinary drift and gets corrected on the next pass. This module is the whole
 * feature; there is no new write path anywhere.
 *
 * It also means the correction lands at the next meter reading rather than
 * instantly, which is the honest cost: an observation never rebuilds the plan
 * (`lib/plan/planRebuildTrigger.ts`), so the device runs until the reading that
 * sees it.
 *
 * ## Baseline is OFF, and only an ACTIVE task lifts it
 *
 * The hold is level-based and restart-safe by construction: it reads a persisted
 * policy, not an event or an in-memory latch, so a device held before a reboot
 * is still held after one.
 *
 * The lift is `PlanInputDevice.startPolicyHoldLifted`, stamped by deferred
 * admission on a `planned` decision — the task has booked energy into this hour
 * and wants the device running. That exclusion is not a detail: it is what makes
 * the policy mean "only PELS starts it" rather than "never runs", because a
 * smart task is the one thing in PELS that positively starts a device (the
 * restore lane only resumes what it shed, and boost only escalates a device
 * already running).
 *
 * The lift rides the DEVICE rather than an id-set handed to this resolver,
 * because the shed set is not the only place the answer is needed: a device that
 * is ALREADY OFF never enters the shed set at all, and `getInactiveReason`
 * (`../restore/devices.ts`) still has to know whether the hold is what keeps it
 * there. While the set reached only this function, that reader answered from the
 * raw policy, so a task's planned hour could never start a held device — "it
 * runs when a Smart task needs it to" was false for every device the hold had
 * already taken off (release review, 2026-09-10).
 *
 * It is deliberately NARROWER than the precedence set the solar-surplus hold
 * uses (the `excludeIds` union built in `planBuilderSurplus.ts`), which also
 * contains `idle` and avoided devices — a
 * task that is on track with nothing booked this hour, or one deferring to a
 * cheaper one. Those devices are governed but NOT driven, and a baseline of off
 * must survive them: excluding them would let the ordinary restore lane start a
 * device its own task had just decided to leave alone. The blunter case is the
 * one the feature exists for — a task whose precondition failed (an EV that will
 * not report its state of charge) is `inactive`, so the device is held and a
 * manual start is turned back off.
 *
 * ## Not capacity pressure
 *
 * A device held here is off because its owner said so, not because the house is
 * short of power. It must therefore NOT count toward the keep-invariant stepped
 * clamp — see `isStartPolicyHoldShed` in `../planDevices.ts`, the exclusion
 * `awaitingSolarSurplus` already needed for exactly this reason. Counting it
 * would cap unrelated stepped loads at their lowest step while merely respecting
 * a configuration choice.
 *
 * The per-device reason is the stable `awaitingPelsStart` code — no embedded
 * numbers or timestamps, so it is byte-stable across plan cycles (rebuild-storm
 * class, f1550cea) — and reason normalization adopts it for held ids the same way
 * it adopts `awaitingSolarSurplus`, so a fresh capacity or shortfall shed
 * decision still wins the reason.
 */
export type StartPolicyHoldResult = {
  holdIds: Set<string>;
  reasonById: Map<string, DeviceReason>;
};

export function resolveStartPolicyHold(
  devices: readonly PlanInputDevice[],
): StartPolicyHoldResult {
  const holdIds = new Set<string>();
  const reasonById = new Map<string, DeviceReason>();
  for (const device of devices) {
    if (!isStartPolicyHeldDevice(device)) continue;
    holdIds.add(device.id);
    reasonById.set(device.id, { code: PLAN_REASON_CODES.awaitingPelsStart });
  }
  return { holdIds, reasonById };
}

/**
 * Is this device held off by its start policy RIGHT NOW? THE single definition,
 * shared by {@link resolveStartPolicyHold} (which turns it into shed-set
 * membership and a reason), by the plan-side keep-invariant predicate
 * `isStartPolicyHoldShed` in `planDevices.ts`, and — through the flag
 * `buildBasePlanDevice` stamps from it — by `getInactiveReason` and starvation
 * eligibility on the output device.
 *
 * One definition rather than several hand-mirrored ones, because the surplus
 * posture proved what mirroring costs here: its two copies drifted, and a pump
 * waiting for solar clamped unrelated stepped loads to their lowest step until
 * someone noticed. The start policy then repeated it in a worse form — the
 * task-driven exclusion lived in the resolver only, so the two output-side
 * readers answered from the raw policy and a smart task could never start a
 * device the hold had taken off.
 *
 * Deliberately does NOT consult the control posture beyond `managed`. It does not
 * need to: the policy is itself one of the standing grants `commandAuthority` is
 * OR'd from (`resolveDeviceControlPosture`), so a `pels_only` managed device
 * always has the lever this hold assumes. Re-checking authority here would be the
 * conjunction this feature exists to avoid — the policy is most useful exactly
 * where power-limit control is OFF.
 */
// `'pels_only'` is compared inline here rather than through a shared predicate.
// The two backend readers of this question — this hold and
// `applyDeferredAdmissionToInput` — cannot import each other
// (`no-objectives-to-peer`), and shared-domain is not the answer: that package
// requires a real browser consumer, and a predicate placed there to bridge two
// backend peers is the bypass root `AGENTS.md` names. The same rule prescribes
// what to do instead — accept the duplication and record the constraint.
export function isStartPolicyHeldDevice(device: PlanInputDevice): boolean {
  return device.startPolicy === 'pels_only'
    && device.control.managed
    && device.startPolicyHoldLifted !== true;
}

/**
 * Is THIS CYCLE's shed of this device its start-policy hold, rather than
 * capacity pressure?
 *
 * A fresh shed decision (`shedReasons`) means capacity took the device down, and
 * that is real pressure: it keeps the owner's configured limiting floor, and it
 * counts toward the keep-invariant stepped clamp. A device shed with no fresh
 * reason is held by the posture, and the posture is off — not a floor, and not
 * pressure.
 *
 * One definition, three readers (the shed-behaviour override in
 * `planDevicesBase`, the keep-invariant exclusion in `planDevices`, and the
 * reason the executor mirrors), because the surplus twin proved what mirroring
 * costs: its two copies drifted, and a pump waiting for solar clamped unrelated
 * stepped loads to their lowest step until someone noticed.
 */
export function isStartPolicyHoldShed(
  device: PlanInputDevice,
  shedReasons: ReadonlyMap<string, DeviceReason>,
): boolean {
  if (!isStartPolicyHeldDevice(device)) return false;
  const reason = shedReasons.get(device.id);
  // No fresh reason, or this posture's OWN reason. The second arm is what the
  // silent-meter pass needs: it fills one map with both the posture reasons and
  // its fail-closed directive before the device build, where the measured pass
  // keeps the posture reasons in a separate map until reason normalization. A
  // shed whose reason IS this posture is trivially this posture, so reading it
  // as capacity pressure sent the device to the owner's power-limiting floor
  // instead of off, on the one path where nothing can measure the result.
  return reason === undefined || reason.code === PLAN_REASON_CODES.awaitingPelsStart;
}

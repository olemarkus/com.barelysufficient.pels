import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlanDevice } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { isActiveSteppedRestoreCandidate } from './restore/devices';

/**
 * The order the restore pass admits in once the timer lifts, so the card that
 * counts down is the one that actually resumes first: off candidates
 * (`applyRestoreCandidates` — binary and off stepped, by priority), then
 * active stepped increases (`applyActiveSteppedRestoreCandidates`), then
 * setpoint raises in the hold lane (`planReasonsHoldDecisions.ts`). Priority
 * orders within a lane; it does not jump a lane.
 */
function admissionLane(device: DevicePlanDevice): 0 | 1 | 2 {
  if (isSteppedLoadDevice(device) && isActiveSteppedRestoreCandidate(device)) return 1;
  if (device.shedAction === 'set_temperature') return 2;
  return 0;
}

function resumesBefore(a: DevicePlanDevice, b: DevicePlanDevice): boolean {
  const laneA = admissionLane(a);
  const laneB = admissionLane(b);
  return laneA === laneB ? a.priority < b.priority : laneA < laneB;
}

/**
 * ONE card says `Waiting to resume — 55s`; the rest of the held cohort says
 * `Waiting to resume — other devices are ahead`.
 *
 * While a global restore cooldown holds, every lane marks its candidates with
 * the same countdown (`restore/marking.ts` for binary and stepped devices,
 * `planReasonsHoldDecisions.ts` for setpoint devices) — the planner decides
 * nothing until the timer lifts, so per lane there is nothing else to say.
 * Which of them resumes first is the cross-lane admission order above, so it
 * is settled once here, on the finished device list, before the plan reaches
 * any carrier: the settings card, the device activity log
 * (`deviceOverviewLog.ts`, which must log the line the card rendered) and the
 * debug dump all read the same reasons. This is a flat rewrite of a value each
 * lane already resolved — not the second, hypothetical admission pass the
 * planner used to run for exactly this line.
 *
 * Applied only while a restore cooldown is running (`planBuilderMaterialization`
 * gates it on the pass's timing): the countdown code has other producers — the
 * one-restore-per-cycle gate, the shedding latch's stay-off ladder — whose
 * devices are not queued behind a timer, and those keep their own countdown.
 */
export function rankRestoreCooldownCohort(devices: DevicePlanDevice[]): DevicePlanDevice[] {
  const [first, ...rest] = devices.filter((device) => device.reason.code === PLAN_REASON_CODES.cooldownRestore);
  if (first === undefined || rest.length === 0) return devices;
  let next = first;
  for (const device of rest) {
    if (resumesBefore(device, next)) next = device;
  }
  return devices.map((device) => (
    device.reason.code === PLAN_REASON_CODES.cooldownRestore && device.id !== next.id
      ? { ...device, reason: { code: PLAN_REASON_CODES.waitingForOtherDevices } }
      : device
  ));
}

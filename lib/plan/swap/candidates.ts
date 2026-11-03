import type { DevicePlanDevice, MeteredDevicePlanDevice } from '../planTypes';
import {
  SWAP_RESTORE_RESERVE_KW,
} from '../planConstants';
import { buildRestoreAdmissionMetrics, isRestoreAdmitted, type RestoreAdmissionMetrics } from '../admission';
import { isSteppedLoadDevice, resolveStepChangeKw, resolveSteppedLoadPlanningKw } from '../planSteppedLoad';
import {
  getSteppedLoadLowestActiveStep, getSteppedLoadStep,
} from '../../../packages/shared-domain/src/deviceControlProfiles';
import { getSteppedLoadNextLowerStep } from '../../utils/steppedLoadLadder';
import type { SwapDonorRelease, SwapLedger } from './swapLedger';

/** A running device the swap pauses, and what it gives up. */
export type SwapDonor = {
  device: MeteredDevicePlanDevice;
  release: SwapDonorRelease;
};

/** Whether a stepped donor reports the step a swap lowered it to, or one below it. */
function hasSteppedDownTo(onDev: MeteredDevicePlanDevice, stepId: string): boolean {
  if (!isSteppedLoadDevice(onDev)) return false;
  const held = getSteppedLoadStep(onDev.steppedLoadProfile, stepId);
  const reported = getSteppedLoadStep(onDev.steppedLoadProfile, onDev.reportedStepId);
  return held !== null && reported !== null && reported.planningPowerW <= held.planningPowerW;
}

/**
 * Whether `onDev` can give up draw to a swap for `dev`: it is drawing
 * something, was not restored this cycle, and is not spoken for.
 *
 * A donor another swap stepped down (never one it switched off) is spoken for
 * only by the targets that swap and any later one took it for. A target ranked
 * above all of them (lower priority number) may take it further down, once it
 * reports the step it was given: its further relief is then priced from what it
 * draws there, and the watts its first step-down freed are already in the
 * reading rather than counted again. A target ranked at or below one of them
 * waits for that swap, as its restore does. Its `shed` plan is the swap's own
 * hold, so it does not rule it out.
 *
 * Also the answer to a question the search itself cannot ask — *could a swap
 * free anything at all?* — and that answer has to come from the same predicate
 * the search uses, or the two drift apart.
 */
function canReleaseDrawForSwap(
  onDev: MeteredDevicePlanDevice,
  dev: DevicePlanDevice,
  ledger: SwapLedger,
  deviceMap: ReadonlyMap<string, DevicePlanDevice>,
  restoredThisCycle: ReadonlySet<string>,
): boolean {
  if (onDev.currentDrawKw <= 0) return false;
  if (restoredThisCycle.has(onDev.id)) return false;
  const release = ledger.donorRelease(onDev.id);
  if (release === undefined) return onDev.plannedState !== 'shed';
  return release.kind === 'step' && hasSteppedDownTo(onDev, release.stepId)
    && ledger.isHeldOnlyBelow(onDev.id, dev.priority, deviceMap);
}

/**
 * Whether any running device could be paused to fund `dev`'s restore this
 * cycle. False means the swap avenue does not exist — `buildSwapCandidates`
 * would walk the whole list and come back with nothing to shed — so the
 * caller's own rejection is already the decision.
 *
 * Evaluated per candidate rather than once per pass: `plannedState`,
 * the ledger's donor set and `restoredThisCycle` all move as the pass runs, and a
 * verdict cached before the first admission would be stale by the second.
 */
export function hasSwappableDraw(
  dev: DevicePlanDevice,
  onDevices: readonly MeteredDevicePlanDevice[],
  ledger: SwapLedger,
  deviceMap: ReadonlyMap<string, DevicePlanDevice>,
  restoredThisCycle: ReadonlySet<string>,
): boolean {
  return onDevices.some((onDev) => canReleaseDrawForSwap(onDev, dev, ledger, deviceMap, restoredThisCycle));
}

function isViableSwapCandidate(
  onDev: MeteredDevicePlanDevice,
  dev: DevicePlanDevice,
  ledger: SwapLedger,
  deviceMap: ReadonlyMap<string, DevicePlanDevice>,
  restoredThisCycle: ReadonlySet<string>,
): boolean {
  if (!canReleaseDrawForSwap(onDev, dev, ledger, deviceMap, restoredThisCycle)) return false;
  const onDevPriority = onDev.priority;
  const devPriority = dev.priority;
  if (onDevPriority <= devPriority) return false;
  // A NON-exempt target must not count freed draw from a budget-exempt source:
  // its budget axis is `budgetPaceKw + measuredExemptKw − total`, and turning
  // the exempt source off drops `measuredExemptKw` and `total` together — the
  // target's admission axis never grows, so the swap pauses a running exempt
  // device for a restore that is re-rejected every cycle until the swap times
  // out (strand + churn of exactly the device class the exemption protects).
  // Cost of the blanket rule: in a purely capacity-bound home a non-exempt
  // target can no longer swap out a lower-priority exempt source — a rare,
  // conservative narrowing that matches the exemption's intent.
  if (onDev.budgetExempt && !dev.budgetExempt) return false;
  return true;
}

/**
 * What a donor gives up, and the draw that frees: the gentlest lower step that
 * alone completes the swap, or a stop when no step does (and for a device
 * without steps). A lower step that is enough is preferred over a stop: the
 * donor keeps delivering, and a stopped charger can take minutes to draw again
 * once it is restarted. Each step is priced by `resolveStepChangeKw`, so it is
 * never credited with more than the donor is measured drawing.
 *
 * An EV charger's lower step is credited only down to its full nameplate. The
 * step estimate scales a descent by measured over nameplate draw, which fits a
 * car on fewer phases, but a car limiting itself (tapering near full) keeps the
 * same draw at the lower step and frees nothing. The swap lets a target start
 * on this relief, so it takes the sure figure; when no step frees enough that
 * way, the charger stops, as before steps were offered.
 */
function resolveDonorRelease(
  onDev: MeteredDevicePlanDevice,
  potentialKw: number,
  neededKw: number,
): { release: SwapDonorRelease; reliefKw: number } {
  const stop = { release: { kind: 'off' } as const, reliefKw: onDev.currentDrawKw };
  if (!isSteppedLoadDevice(onDev)) return stop;
  const profile = onDev.steppedLoadProfile;
  const floor = getSteppedLoadLowestActiveStep(profile);
  if (!floor) return stop;
  for (
    let step = getSteppedLoadNextLowerStep(profile, onDev.selectedStepId, floor.id);
    step !== null;
    step = getSteppedLoadNextLowerStep(profile, step.id, floor.id)
  ) {
    const change = resolveStepChangeKw(onDev, onDev.selectedStepId, step.id);
    if (change.direction !== 'down') continue;
    const reliefKw = onDev.isEvCharger
      ? Math.max(0, Math.min(change.deltaKw, onDev.currentDrawKw - resolveSteppedLoadPlanningKw(onDev, step.id)))
      : change.deltaKw;
    const availableKw = Math.max(0, potentialKw + reliefKw - SWAP_RESTORE_RESERVE_KW);
    if (isRestoreAdmitted(buildRestoreAdmissionMetrics({ availableKw, neededKw }))) {
      return { release: { kind: 'step', stepId: step.id }, reliefKw };
    }
  }
  return stop;
}

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function buildSwapCandidates(
  dev: DevicePlanDevice,
  onDevices: MeteredDevicePlanDevice[],
  ledger: SwapLedger,
  /** The cycle's devices: the ranks of the targets a donor is already held for. */
  deviceMap: ReadonlyMap<string, DevicePlanDevice>,
  availableHeadroom: number,
  needed: number,
  restoredThisCycle: ReadonlySet<string>,
): {
  ready: boolean;
  toShed: SwapDonor[];
  shedNames: string;
  shedPower: string;
  potentialHeadroom: number;
  effectiveHeadroom: number;
  // Reason-payload display values from the UNCLAMPED effective headroom —
  // `effectiveHeadroom`/`admission` stay clamped for the admission arithmetic.
  displayEffectiveHeadroomKw: number;
  displayMarginKw: number;
  admission: RestoreAdmissionMetrics;
  reserveKw: number;
} {
  const toShed: SwapDonor[] = [];
  let currentPotential = availableHeadroom;
  let effectiveHeadroom = Math.max(0, currentPotential - SWAP_RESTORE_RESERVE_KW);
  let admission = buildRestoreAdmissionMetrics({ availableKw: effectiveHeadroom, neededKw: needed });

  for (const onDev of onDevices) {
    if (!isViableSwapCandidate(onDev, dev, ledger, deviceMap, restoredThisCycle)) continue;

    const { release, reliefKw } = resolveDonorRelease(onDev, currentPotential, needed);
    toShed.push({ device: onDev, release });
    currentPotential += reliefKw;
    effectiveHeadroom = Math.max(0, currentPotential - SWAP_RESTORE_RESERVE_KW);
    admission = buildRestoreAdmissionMetrics({ availableKw: effectiveHeadroom, neededKw: needed });

    if (isRestoreAdmitted(admission)) break;
  }

  const ready = isRestoreAdmitted(admission);
  const names = toShed.map((d) => d.device.name).join(', ');
  // Display values from the UNCLAMPED effective headroom. The `Math.max(0, …)`
  // clamp above protects the admission arithmetic, but a margin computed off
  // the clamped value flattens the displayed shortfall to `needed + reserves`
  // whenever `currentPotential < SWAP_RESTORE_RESERVE_KW` (deep over-pace),
  // understating the honest gap by however far potential sits below the
  // reserve — unbounded as overshoot grows. Admission keeps the clamped value;
  // both reject in that region, so control behavior is unchanged.
  const displayEffectiveHeadroomKw = currentPotential - SWAP_RESTORE_RESERVE_KW;
  const displayAdmission = buildRestoreAdmissionMetrics({
    availableKw: displayEffectiveHeadroomKw,
    neededKw: needed,
  });

  return {
    ready,
    toShed,
    shedNames: names,
    shedPower: (currentPotential - availableHeadroom).toFixed(2),
    potentialHeadroom: currentPotential,
    effectiveHeadroom,
    displayEffectiveHeadroomKw,
    displayMarginKw: displayAdmission.marginKw,
    admission,
    reserveKw: SWAP_RESTORE_RESERVE_KW,
  };
}
/* eslint-enable functional/immutable-data */


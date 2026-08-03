import type { DevicePlanDevice } from '../planTypes';
import type { PlanEngineState } from '../planState';
import type { SwapState } from '../swap';
import { getRestoreCandidates, markOffDevicesStayOff } from './devices';
import { markSteppedDevicesStayAtCurrentLevel, setRestorePlanDevice as setDevice } from './helpers';
import type { RestoreTiming } from './timing';
import type { HeadroomReserve } from '../admission';
import type { RestoreHeadroomLedger } from './headroomLedger';
import { buildDisabledRestoreBatchState } from './batch';
import {
  applyActiveSteppedRestoreCandidates,
  applyRestoreCandidates,
  buildSteppedSwapExecutor,
} from './candidateLoop';
import type { RestoreDeps } from './types';

const isBudgetExempt = (dev: DevicePlanDevice): boolean => dev.budgetExempt === true;

/**
 * Restricted restore pass for budget-exempt candidates while shedding is
 * latched by a budget-driven overshoot (`shouldPlanBudgetExemptRestores`).
 * Admits only budget-exempt candidates — capacity axis only, via the ledger's
 * exempt routing — with no swap (swap frees budget-axis power the exempt
 * candidate does not read) and no batch continuation (off-candidate admissions
 * are one per cycle, matching the restore-eagerness one-at-a-time rule; an
 * active exempt stepper's per-rung step-up bypasses that global gate exactly
 * as it does in the full pass, bounded by its own attempt-hold and per-device
 * restore timing). Non-exempt
 * devices are marked first with the exact stay-off / stay-at-level reasons of
 * the ordinary blocked branch, and the marking excludes exempt devices so it
 * cannot overwrite an admission made below it.
 *
 * Out of scope: set_temperature/target-only exempt devices — the hold lane
 * stays gated by `inShedWindow` (`planReasonsHoldDecisions`); this lane covers
 * binary and stepped candidates, matching the ledger's admission surface.
 * Governing note: `notes/safe-pace-two-constraints.md` § "Proposed model".
 */
export function applyBudgetExemptRestorePass(params: {
  deviceMap: Map<string, DevicePlanDevice>;
  swapState: SwapState;
  state: PlanEngineState;
  timing: RestoreTiming;
  ledger: RestoreHeadroomLedger;
  restoredThisCycle: Set<string>;
  restoredOneThisCycle: boolean;
  headroomReserves: readonly HeadroomReserve[];
  deps: RestoreDeps;
}): { restoredOneThisCycle: boolean } {
  const { deviceMap, swapState, state, timing, ledger, restoredThisCycle, headroomReserves, deps } = params;
  let { restoredOneThisCycle } = params;

  // Mark non-exempt devices FIRST (and only them): an admitted exempt device is
  // still observed off this cycle, so an unfiltered mark afterwards would
  // overwrite its admission back to 'shed'.
  markOffDevicesStayOff({
    deviceMap,
    timing,
    setDevice: (id, updates) => setDevice(deviceMap, id, updates),
    getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
    deviceFilter: (dev) => !isBudgetExempt(dev),
  });
  markSteppedDevicesStayAtCurrentLevel({
    deviceMap,
    timing,
    getLastControlledMs: (deviceId) => state.lastDeviceControlledMs[deviceId],
    deviceFilter: (dev) => !isBudgetExempt(dev),
  });

  // No swap sources: attemptSwapRestore finds nothing and falls through to the
  // ordinary insufficient-headroom reject.
  const steppedSwapExecutor = buildSteppedSwapExecutor({
    deviceMap,
    onDevices: [],
    swapState,
    state,
    timing,
    restoredThisCycle,
    deps,
  });
  const restoreCandidates = getRestoreCandidates(Array.from(deviceMap.values()))
    .filter((candidate) => isBudgetExempt(candidate.device));
  ({ restoredOneThisCycle } = applyRestoreCandidates({
    restoreCandidates,
    deviceMap,
    onDevices: [],
    swapState,
    state,
    timing,
    ledger,
    restoredThisCycle,
    restoredOneThisCycle,
    batchState: buildDisabledRestoreBatchState(),
    deps,
    steppedSwapExecutor,
    headroomReserves,
  }));
  ({ restoredOneThisCycle } = applyActiveSteppedRestoreCandidates({
    deviceMap,
    swapState,
    state,
    timing,
    ledger,
    restoredOneThisCycle,
    debugStructured: deps.debugStructured,
    steppedSwapExecutor,
    headroomReserves,
    candidateFilter: isBudgetExempt,
  }));
  return { restoredOneThisCycle };
}

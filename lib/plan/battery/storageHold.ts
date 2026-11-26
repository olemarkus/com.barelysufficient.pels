import type { ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';
import type { StorageDecision } from '../../planContract/storageDecision';
import type { StorageLeverState } from '../planState';
import type { StorageClaimReason, StorageStateSummary } from './storageReliefTypes';
import {
  STORAGE_RELIEF_SETTLE_WINDOW_MS, ownChargeWOf, ownDischargeWOf, resolveChargeAboveLimitW,
} from './storageLadder';

/** Shared state for a routine or economic hold. */
export const startContinuousLever = (
  storage: ObservedStorageInput,
  setpointW: number,
  nowTs: number,
): StorageLeverState => ({
  setpointW,
  purpose: 'continuous',
  increaseDecidedAtMs: nowTs - STORAGE_RELIEF_SETTLE_WINDOW_MS,
  creditBaseW: 0,
  lastDecreaseAtMs: nowTs,
  chargeRaisedAtMs: nowTs,
  lastNeedAtMs: nowTs,
  limitedChargeW: 0,
  stepW: storage.range.stepW,
  reading: { kind: 'read' },
});

/** Why the plan holds the battery this cycle, for the state log and the overview. */
export const resolveClaimReason = (lever: StorageLeverState): StorageClaimReason => {
  if (lever.purpose === 'limit') return lever.setpointW < 0 ? 'relief' : 'charge_limit';
  if (lever.setpointW < 0) return lever.continuousReason === 'export_energy' ? 'plan_export' : 'plan_supply';
  if (lever.setpointW === 0) return 'plan_wait';
  return lever.continuousReason === 'charge_grid' ? 'plan_charge' : 'plan_solar';
};

/** Under a charge limit, the charge it holds back, W; 0 under any other hold. */
const resolveHeldBackChargeW = (lever: StorageLeverState): number => (
  resolveClaimReason(lever) === 'charge_limit' ? resolveChargeAboveLimitW(lever) : 0
);

/**
 * What restore and admission may not spend for a battery held at this
 * setpoint, W: the discharge it holds or still delivers, and a charge increase
 * the measurement does not show yet.
 */
const resolveWithheldW = (storage: ObservedStorageInput, setpointW: number): number => (
  Math.max(0, -setpointW, ownDischargeWOf(storage)) + Math.max(0, setpointW - ownChargeWOf(storage))
);

export const toSetpointDecision = (lever: StorageLeverState): StorageDecision => (
  { kind: 'setpoint', setpointW: lever.setpointW, stepW: lever.stepW }
);

export const summarizeHold = (
  deviceId: string,
  storage: ObservedStorageInput,
  lever: StorageLeverState,
  creditW: number,
): StorageStateSummary => ({
  deviceId,
  reading: 'observed',
  claimHeld: storage.claimHeld,
  powerLimitOff: !storage.powerLimitControl,
  claim: resolveClaimReason(lever),
  decision: toSetpointDecision(lever),
  setpointW: lever.setpointW,
  ...(lever.exportPhase === undefined ? {} : { exportPhase: lever.exportPhase }),
  heldBackChargeW: resolveHeldBackChargeW(lever),
  creditW,
  withheldW: resolveWithheldW(storage, lever.setpointW),
});

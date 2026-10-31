import type { ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';
import type { StorageDecision } from '../../planContract/storageDecision';
import type { StorageLeverState } from '../planState';
import type { StorageClaimReason, StorageStateSummary } from './storageReliefTypes';
import {
  STORAGE_RELIEF_SETTLE_WINDOW_MS, deadbandWFor, ownChargeWOf, ownDischargeWOf, resolveOwnModeChargeAboveHoldW,
} from './storageLadder';

/**
 * The charge its own mode takes once handed back, W
 * (`StorageLeverState.ownModeChargeW`). On a battery plan, the plan's charge
 * (nothing while the plan supplies or waits). Otherwise what it charged when
 * PELS claimed it, within its charge ceiling; nothing when it was discharging
 * then (its own mode was covering the house, and gets that back); or its
 * charge ceiling when it was doing neither. One sample of a battery idle or
 * ramping at the claim is no evidence its own mode will not charge hard once
 * handed back, and a hand-back sized on it would recreate the deficit every
 * restore cooldown.
 */
export const resolveOwnModeChargeW = (storage: ObservedStorageInput, preClaimSignedW: number): number => {
  if (storage.continuousPlan !== undefined) return Math.max(0, storage.continuousPlan.setpointW);
  const deadbandW = deadbandWFor(storage);
  if (preClaimSignedW <= -deadbandW) return 0;
  return preClaimSignedW >= deadbandW ? Math.min(preClaimSignedW, storage.chargeCeilingW) : storage.chargeCeilingW;
};

/** A new surplus hold at this charge: it caps a charge, so it has no discharge to settle. */
export const claimSurplusLever = (
  storage: ObservedStorageInput,
  setpointW: number,
  nowTs: number,
): StorageLeverState => ({
  setpointW,
  purpose: 'surplus',
  increaseDecidedAtMs: nowTs - STORAGE_RELIEF_SETTLE_WINDOW_MS,
  creditBaseW: 0,
  lastDecreaseAtMs: nowTs,
  chargeRaisedAtMs: nowTs,
  lastNeedAtMs: nowTs,
  preClaimSignedW: storage.signedPowerW,
  ownModeChargeW: resolveOwnModeChargeW(storage, storage.signedPowerW),
  stepW: storage.range.stepW,
  reading: { kind: 'read' },
});

/** Why the plan holds the battery this cycle, for the state log and the overview. */
export const resolveClaimReason = (lever: StorageLeverState): StorageClaimReason => {
  if (lever.purpose === 'limit') return lever.setpointW < 0 ? 'relief' : 'charge_limit';
  if (lever.purpose === 'continuous') {
    if (lever.setpointW < 0) return 'plan_supply';
    if (lever.setpointW <= 0) return 'plan_wait';
    return lever.continuousReason === 'store_solar' ? 'plan_solar' : 'plan_charge';
  }
  return lever.setpointW < Math.max(0, lever.preClaimSignedW) ? 'cap_for_device' : 'raise_charge';
};

/** Under a charge limit, the charge it holds back, W; 0 under any other hold. */
const resolveHeldBackChargeW = (lever: StorageLeverState): number => (
  resolveClaimReason(lever) === 'charge_limit' ? resolveOwnModeChargeAboveHoldW(lever) : 0
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
  heldBackChargeW: resolveHeldBackChargeW(lever),
  creditW,
  withheldW: resolveWithheldW(storage, lever.setpointW),
});

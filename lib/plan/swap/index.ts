export { isBlockedBySwapState } from './blocking';
export { buildSwapCandidates } from './candidates';
export {
  buildRequestedTargetFromDeviceUpdate,
  cleanupCompletedSwaps,
  cleanupStaleSwaps,
  markDeviceSwappedOutFor,
  markSwapTargetPending,
  recordRequestedTarget,
  recordSwapPlanMeasurement,
  shouldDeferSwapAdmissionForMeasurement,
  shouldKeepSwapTargetPending,
} from './lifecycle';
export {
  buildSwapState,
  exportSwapState,
  type SwapState,
  type SwapStateSnapshot,
} from './state';

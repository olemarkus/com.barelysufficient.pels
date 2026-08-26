import type { DeviceDescriptor, ObservedDeviceState } from '../../packages/contracts/src/types';
import { isCanSetControl } from '../device/deviceActionProjection';

/**
 * Consumed only by `lib/executor` (`binaryRestoreHelpers.ts`,
 * `steppedLoadExecutorRestore.ts`), but it cannot live there: resolving
 * commandability from a raw snapshot is a producer call, and it needs
 * `isCanSetControl` from `lib/device` — an edge `no-executor-to-device-internals`
 * forbids. It stays on this side of that boundary rather than the rule being
 * widened for it. Its former housemates moved to `lib/executor/executorSupport.ts`.
 */
/**
 * Restore-time admission gate: true when the device is commandable AND its
 * binary control capability is writeable this cycle. Reads producer-resolved
 * bits (`commandableNow`, `canSetControlResolved`) when present (planner
 * call sites) and falls back to resolution from the observer's semantic binary
 * state plus descriptor writeability flags for executor snapshot call sites.
 *
 * Chunk 6 of the planner-detype refactor: producer now resolves both bits
 * so this gate no longer round-trips through `getBinaryControlPlan` +
 * `getEvRestoreBlockReason`.
 *
 * Reads observer-resolved commandability plus descriptor writeability — the decomposed snapshot halves, not
 * the raw producer `TargetDeviceSnapshot`. The full snapshot stays assignable.
 */
export type CanTurnOnDeviceSnapshot = ObservedDeviceState
  & Pick<DeviceDescriptor, 'capabilities' | 'canSetControl'>
  & { currentOn?: boolean; commandableNow?: boolean };

export const canTurnOnDevice = (snapshot?: CanTurnOnDeviceSnapshot): boolean => {
  if (!snapshot) return false;
  // `canTurnOnDevice` takes a raw observed snapshot, so this IS the producer
  // call — the one sanctioned reader of the plug-state for this carrier.
  if (snapshot.commandableNow === false || snapshot.available === false) return false;
  if (!isCanSetControl({
    binaryControl: snapshot.binaryControl,
    currentOn: snapshot.currentOn,
    capabilities: snapshot.capabilities,
    canSetControl: snapshot.canSetControl,
    canSetOnOff: (snapshot as { canSetOnOff?: boolean }).canSetOnOff,
  })) return false;
  return true;
};

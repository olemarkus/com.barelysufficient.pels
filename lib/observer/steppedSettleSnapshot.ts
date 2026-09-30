/**
 * Project decorated devices onto the stepped axis's settle evidence — the twin
 * of `buildBinaryCommandConfirmationSnapshot`
 * (`lib/device/transport/binaryCommandConfirmationSnapshot.ts`), and read the
 * same way.
 *
 * The device owner has already resolved the active ladder and admitted the
 * reported rung. This projection trusts that observation and preserves its
 * source timestamp; unrelated capability updates cannot refresh step evidence.
 *
 * A pure read. It is the input to a settle pass, not a settle pass.
 *
 * It lives with the observer rather than beside the transport because it IS an
 * observation projection, and because the on/off fold it needs (`resolveCurrentOn`)
 * is the observer's. `lib/device` may not reach into `lib/observer`
 * (`no-device-to-peer-except-power`), and routing around that with a type-only
 * import would be dodging the rule rather than answering it.
 */

/**
 * One device's settle evidence. `unavailable` is not "off" and not "unknown at
 * the rung level" — it means the device has nothing to say about a rung right
 * now (no ladder, or nothing reported), so no command conclusion may be drawn
 * from it. Same `unavailable | observed` shape the binary confirmation uses.
 */
export type SteppedCommandConfirmation =
  | { state: 'unavailable' }
  | { state: 'observed'; observedStepId: string; observedAtMs: number };

export type SteppedSettleDevice = {
  id: string;
  /** The ladder's lowest active rung, for reconciling the initialization latch. */
  lowestActiveStepId: string | undefined;
  /** Whether the device is drawing at all — the on/off fold, producer-resolved. */
  observedOn: boolean;
  steppedCommandConfirmation: SteppedCommandConfirmation;
};
import {
  getSteppedLoadLowestActiveStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import { resolveCurrentOn } from './observedState';
import type { SteppedLoadProfile, ReportedStepObservedProbe } from '../../packages/contracts/src/types';

/**
 * The device shape this reads. Deliberately structural and narrow: the fields a
 * settle pass needs, not a whole decorated snapshot, so the projection cannot
 * quietly grow a dependency on decoration's other outputs.
 */
export type SteppedSettleSourceDevice = {
  id: string;
  binaryControl?: { on: boolean };
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
} & Pick<ReportedStepObservedProbe, 'reportedStepId' | 'reportedStepObservedAtMs'>;

const resolveConfirmation = (
  device: SteppedSettleSourceDevice,
): SteppedSettleDevice['steppedCommandConfirmation'] => {
  const observedStepId = device.reportedStepId;
  if (observedStepId === undefined || device.reportedStepObservedAtMs === undefined) {
    return { state: 'unavailable' };
  }
  return { state: 'observed', observedStepId, observedAtMs: device.reportedStepObservedAtMs };
};

export const buildSteppedSettleSnapshot = (
  devices: readonly SteppedSettleSourceDevice[],
): SteppedSettleDevice[] => devices.flatMap((device) => {
  const profile = device.steppedLoadProfile;
  // No ladder, nothing to settle: the device has no rung axis for a command to
  // be about. Dropped rather than reported `unavailable`, so the sweep iterates
  // only devices the stepped lifecycle can say anything about.
  if (!profile) return [];
  return [{
    id: device.id,
    lowestActiveStepId: getSteppedLoadLowestActiveStep(profile)?.id,
    observedOn: resolveCurrentOn({
      binaryControl: device.binaryControl,
      steppedLoadProfile: profile,
      selectedStepId: device.selectedStepId,
    }),
    steppedCommandConfirmation: resolveConfirmation(device),
  }];
});

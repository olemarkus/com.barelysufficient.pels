/**
 * Project decorated devices onto the stepped axis's settle evidence — the twin
 * of `buildBinaryCommandConfirmationSnapshot`
 * (`lib/device/transport/binaryCommandConfirmationSnapshot.ts`), and read the
 * same way.
 *
 * The device carries its own ladder by the time it reaches here: setup resolves
 * it from whatever source it has — stored config, or the device's native
 * stepped descriptor — and writes it onto the device. So validating a reported
 * rung is a question this projection can answer from the device alone, exactly
 * as the binary projection answers from the device's capability list, and no
 * consumer downstream needs a profile lookup to interpret the result.
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
  /**
   * The device's own wiring reports its rung, so a Flow report is superseded.
   * Carried rather than acted on during decoration: dropping the stale report
   * is a state change, and the projection makes none.
   */
  nativeSteppedControlEnabled: boolean;
  /** The ladder's lowest active rung, for reconciling the initialization latch. */
  lowestActiveStepId: string | undefined;
  /** Whether the device is drawing at all — the on/off fold, producer-resolved. */
  observedOn: boolean;
  steppedCommandConfirmation: SteppedCommandConfirmation;
};
import { getSteppedLoadLowestActiveStep, getSteppedLoadStep } from '../utils/deviceControlProfiles';
import { resolveCurrentOn } from './observedState';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

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
  reportedStepId?: string;
  nativeSteppedControlEnabled?: boolean;
  lastUpdated?: number;
};

const resolveConfirmation = (
  device: SteppedSettleSourceDevice,
  profile: SteppedLoadProfile,
): SteppedSettleDevice['steppedCommandConfirmation'] => {
  // The rung must name a step on THIS ladder. A report that does not is not a
  // weaker observation, it is not an observation of this device's rung at all.
  const observedStepId = getSteppedLoadStep(profile, device.reportedStepId)?.id;
  if (observedStepId === undefined || device.lastUpdated === undefined) {
    return { state: 'unavailable' };
  }
  return { state: 'observed', observedStepId, observedAtMs: device.lastUpdated };
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
    nativeSteppedControlEnabled: device.nativeSteppedControlEnabled === true,
    lowestActiveStepId: getSteppedLoadLowestActiveStep(profile)?.id,
    observedOn: resolveCurrentOn({
      binaryControl: device.binaryControl,
      steppedLoadProfile: profile,
      selectedStepId: device.selectedStepId,
    }),
    steppedCommandConfirmation: resolveConfirmation(device, profile),
  }];
});

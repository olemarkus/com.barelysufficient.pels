/**
 * Owner-facing wording for a device PELS cannot command right now.
 *
 * Nothing carries these strings on a device any more — they are looked up from
 * the observed state at the surface that renders or logs them, so the wording
 * can change without touching a control decision, and there is no third copy of
 * the plug-state semantic riding along beside the state itself.
 *
 * Both routes (`DeviceReason.detail` on a device card, and the executor's
 * restore-skip log) go through {@link resolveCommandabilityDetail}, so per
 * `feedback_ui_text_shared_with_logs` the owner reads the same words the log
 * records.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

import type { EvObservedProbe } from '../../contracts/src/types';
import {
  type EvBlockingChargingState,
  isEvPlugStateBlocked,
} from './evPlugState';
import { isEvObserved } from './evObservedState';

/**
 * TOTAL over the blocking plug-states — a `Record`, not a lookup that can miss,
 * so adding a blocking state to `isEvPlugStateCommandable` fails to compile
 * until it has wording. Both are states where the electrics say no: there is no
 * car to charge, or the session is exporting.
 */
export const EV_BLOCK_REASONS: Record<EvBlockingChargingState, string> = {
  plugged_out: 'charger is unplugged',
  plugged_in_discharging: 'charger is discharging',
};

export const DEVICE_UNAVAILABLE_REASON = 'device unavailable';
export const EV_RESUME_PROBE_FAILED_REASON = 'charging did not start';

type CommandabilityDetailInput = {
  deviceClass?: string;
  controlCapabilityId?: string;
  available?: boolean;
} & EvObservedProbe;

/**
 * Why PELS is not commanding this device, in the owner's words. Call it only for
 * a device whose `commandableNow` is false — for a commandable device there is
 * nothing to say, and returning a string for one would be the `null`-means-fine
 * shape this replaced.
 *
 * The branches mirror, in order, the three inputs that can veto a command: the
 * EV plug-state, availability, and the executor's resume-probe backoff. Only the
 * first two are observable from the device, so the backoff is the remainder —
 * which is sound exactly while those three are the whole set. **A fourth veto
 * source must add a branch here**, or it will silently render as "charging did
 * not start"; `test/unit/commandabilityDetail.test.ts` pins all three.
 */
export const resolveCommandabilityDetail = (dev: CommandabilityDetailInput): string => {
  if (isEvObserved(dev) && isEvPlugStateBlocked(dev.evChargingState)) {
    return EV_BLOCK_REASONS[dev.evChargingState];
  }
  if (dev.available === false) return DEVICE_UNAVAILABLE_REASON;
  return EV_RESUME_PROBE_FAILED_REASON;
};

/**
 * EV-boost-context wording for the states that block boost activation. Boost is
 * "command it on now", so it blocks on exactly what actuation blocks on — same
 * classification, different vocabulary: these strings speak to the owner looking
 * at the boost panel, the {@link EV_BLOCK_REASONS} ones appear in plan reason
 * detail and logs.
 */
export const EV_BOOST_BLOCK_REASONS: Record<EvBlockingChargingState, string> = {
  plugged_out: 'Car not connected. Boost will not activate.',
  plugged_in_discharging: 'Car is discharging. Boost will not activate.',
};

/**
 * Boost-panel copy for a charger, or `null` when the plug-state does not stand
 * in the way and the panel should fall through to its battery-level lines. The
 * `null` here is the panel's own "no line to show" — it is not standing in for
 * an unknown state, which cannot exist for a snapshotted charger.
 */
export const resolveEvBoostBlockReason = (dev: {
  deviceClass?: string;
  controlCapabilityId?: string;
} & EvObservedProbe): string | null => {
  if (!isEvObserved(dev) || !isEvPlugStateBlocked(dev.evChargingState)) return null;
  return EV_BOOST_BLOCK_REASONS[dev.evChargingState];
};

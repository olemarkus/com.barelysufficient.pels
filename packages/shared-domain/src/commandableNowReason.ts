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
import { isEvObserved } from './evObservedState';
import { type EvBlockingChargingState, isEvPlugStateBlocked } from './evPlugState';

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
export const BINARY_COMMAND_RETRY_REASON = 'device did not respond';

type CommandabilityDetailInput = {
  commandabilityReason?: 'charger_unplugged' | 'charger_discharging' | 'device_unavailable'
    | 'binary_command_retry';
};

/**
 * Why PELS is not commanding this device, in the owner's words. Call it only for
 * a device whose `commandableNow` is false — for a commandable device there is
 * nothing to say, and returning a string for one would be the `null`-means-fine
 * shape this replaced.
 *
 * The branches mirror the observer-resolved reasons that can veto a command.
 */
export const resolveCommandabilityDetail = (dev: CommandabilityDetailInput): string => {
  if (dev.commandabilityReason === 'charger_unplugged') return EV_BLOCK_REASONS.plugged_out;
  if (dev.commandabilityReason === 'charger_discharging') return EV_BLOCK_REASONS.plugged_in_discharging;
  if (dev.commandabilityReason === 'device_unavailable') return DEVICE_UNAVAILABLE_REASON;
  if (dev.commandabilityReason === 'binary_command_retry') return BINARY_COMMAND_RETRY_REASON;
  return DEVICE_UNAVAILABLE_REASON;
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
} & EvObservedProbe): string | null => {
  if (!isEvObserved(dev) || !isEvPlugStateBlocked(dev.evChargingState)) return null;
  return EV_BOOST_BLOCK_REASONS[dev.evChargingState];
};

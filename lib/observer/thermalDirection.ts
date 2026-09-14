/**
 * Observer-owned resolution of which way a device's setpoint moves its demand.
 *
 * PELS shifts demand by writing `target_temperature`, and every setpoint policy
 * it has had assumed one direction: raise = more load. That holds for a water
 * heater and a panel radiator, and it is exactly wrong for a reversible unit
 * running in cooling — a cheap-hour "boost" there raises the setpoint and makes
 * the compressor do LESS work, then the expensive hour lowers it and makes it do
 * more.
 *
 * Same division of labour as `resolveCurrentOn` next door: the transport reports
 * the raw observation (`thermostatMode`) and retains it across a partial update,
 * and this module owns the vocabulary that turns it into truth. Nothing
 * downstream re-derives a direction from a capability value.
 */
import type { ThermalDirection, ThermostatModeObservedProbe } from '../../packages/contracts/src/types';

/**
 * Values that mean "this unit is removing heat right now".
 *
 * Homey's own `thermostat_mode` enum spells it `cool`, but the capability's
 * option list is driver-supplied and apps publish the participle instead —
 * Daikin's ONECTA reports `cooling`/`heating`. Both spellings are admitted
 * rather than picking one and silently mis-directing the other's devices.
 */
const COOLING_MODE_VALUES: ReadonlySet<string> = new Set(['cool', 'cooling']);

/**
 * `auto` is the mode that costs something: a reversible unit in auto may well be
 * cooling, and the mode alone cannot say. It keeps the heating default rather
 * than guessing from the room-vs-setpoint sign — that sign flips as the price
 * shift moves the very setpoint the room is chasing, so the guess would
 * oscillate the delta along with it. An owner whose unit runs in auto and cools
 * turns that device's price response off.
 */
/**
 * The direction this device's setpoint moves demand in.
 *
 * Total, and it takes nothing but the current observation. There is always an
 * answer: a device that reports no mode is heating (a water heater, a panel
 * radiator, every device with no mode axis), and so is one whose mode nobody
 * here can name. `'cooling'` only on positive evidence.
 *
 * No carried previous value and no staleness gate, for the same reason
 * `resolveCurrentOn` has none: Homey reports a capability only on CHANGE, so
 * silence means unchanged, and the last reported mode is what the transport is
 * still holding. See `lib/observer/AGENTS.md` § "A device observation never
 * times out".
 */
export function resolveThermalDirection(device: ThermostatModeObservedProbe | undefined): ThermalDirection {
  // Absence is classified HERE, like the other observer reads: no record means
  // no mode axis anyone has seen, and that is a heater.
  const mode = device?.thermostatMode;
  if (mode !== undefined && COOLING_MODE_VALUES.has(mode)) return 'cooling';
  return 'heating';
}

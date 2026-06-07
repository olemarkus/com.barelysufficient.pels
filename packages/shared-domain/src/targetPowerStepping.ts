import type {
  TargetPowerSteppedLoadConfig,
  TargetPowerSteppedLoadPreset,
} from '../../contracts/src/types';

/**
 * Pure resolution of the amp/watt relationship for a target-power stepped-load
 * device, so consumers (executor planning-current, transport reported-step
 * resolution) read a flat number instead of branching on the config preset.
 *
 * The concrete presets that name the underlying wiring (single-/three-phase EV
 * charger installs) live in the contract + the device/UI layers that build the
 * config; this module only turns a config into the volts-per-amp factor the
 * stepping math needs.
 */

/** Nominal phase voltage (V) for installation-current based stepping. */
const PHASE_VOLTAGE_V = 230;

/**
 * Number of supply phases implied by a target-power config preset, or
 * `undefined` when the preset is unset/unknown.
 */
export const resolveTargetPowerPresetPhaseCount = (
  preset: TargetPowerSteppedLoadPreset | undefined,
): number | undefined => {
  if (preset === 'ev_charger_1_phase') return 1;
  if (preset === 'ev_charger_3_phase') return 3;
  return undefined;
};

/**
 * Watts delivered per amp of installation current for a target-power stepped
 * device, or `undefined` when target-power stepping is disabled or the preset
 * is unset/unknown. `watts = amps * wattsPerAmp` (and inversely
 * `amps = watts / wattsPerAmp`).
 */
export const resolveTargetPowerWattsPerAmp = (
  config: TargetPowerSteppedLoadConfig | undefined,
): number | undefined => {
  if (!config || config.enabled === false) return undefined;
  const phaseCount = resolveTargetPowerPresetPhaseCount(config.preset);
  return phaseCount === undefined ? undefined : PHASE_VOLTAGE_V * phaseCount;
};

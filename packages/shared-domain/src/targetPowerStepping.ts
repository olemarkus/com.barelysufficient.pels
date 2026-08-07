import type { TargetPowerSteppedLoadPreset } from '../../contracts/src/types';

/**
 * Pure resolution of the phase count behind a target-power stepped-load device,
 * so the consumer (transport reported-step resolution) reads a flat number
 * instead of branching on the config preset.
 *
 * The concrete presets that name the underlying wiring (single-/three-phase EV
 * charger installs) live in the contract + the device/UI layers that build the
 * config; this module only turns a preset into the phase count the stepping
 * math needs.
 */

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

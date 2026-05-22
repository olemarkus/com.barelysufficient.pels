import type {
  TargetPowerSteppedLoadConfig,
  TargetPowerSteppedLoadPreset,
} from '../../contracts/src/types.js';

export const createEvTargetPowerConfig = (
  preset: TargetPowerSteppedLoadPreset,
): TargetPowerSteppedLoadConfig => ({
  enabled: true,
  preset,
  ...(preset === 'ev_charger_1_phase'
    ? { min: 0, max: 7360, step: 460, excludeMin: 1, excludeMax: 1380 }
    : { min: 0, max: 22080, step: 1380, excludeMin: 1, excludeMax: 4140 }),
});

export const isEvTargetPowerPreset = (value: unknown): value is TargetPowerSteppedLoadPreset => (
  value === 'ev_charger_1_phase' || value === 'ev_charger_3_phase'
);

import type { EvChargingCurrentLimits, SteppedLoadStep } from '../../packages/contracts/src/types';

export type EvChargingCurrentSource = 'charger' | 'associated_car' | 'confirmed_car';

/** The charging-range owner's resolved capture; observation steps remain separate. */
export type EvChargingCurrentDiagnostics =
  | { kind: 'unrestricted'; source: 'charger'; plannerSteps: readonly SteppedLoadStep[] }
  | { kind: 'hold'; cause: 'limits_unavailable'; source: EvChargingCurrentSource }
  | (({ kind: 'limited' } | { kind: 'hold'; cause: 'no_supported_current' }) & {
    source: EvChargingCurrentSource;
    selectedLimits: EvChargingCurrentLimits;
    effectiveLimits: EvChargingCurrentLimits;
    plannerSteps: readonly SteppedLoadStep[];
  });

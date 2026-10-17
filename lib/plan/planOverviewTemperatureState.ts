import type { ThermalDirection } from '../../packages/contracts/src/types';
import type { OverviewTemperatureState } from '../../packages/shared-domain/src/deviceOverview';
import type { ObservedTemperatureRead } from '../observer/observedDeviceStateProjection';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import type { DevicePlan } from './planTypes';

export type OverviewTemperatureFacet =
  | { kind: 'present'; value: OverviewTemperatureState }
  | { kind: 'absent' };

/**
 * Builds the one temperature facet used by every overview carrier.
 *
 * The observer owns the current pair and the thermal direction; the planner owns
 * `plannedTarget`.
 * Evidence is discriminated before it enters this resolver: consumers never
 * reinterpret nullable transport values or infer why an observation is absent.
 */
export function resolveOverviewTemperatureFacet(
  device: DevicePlan['devices'][number],
  evidence: ObservedTemperatureRead,
  thermalDirection: ThermalDirection,
): OverviewTemperatureFacet {
  if (evidence.kind === 'absent') return { kind: 'absent' };
  return {
    kind: 'present',
    value: {
      currentTarget: evidence.value.currentTarget,
      currentTemperature: evidence.value.currentTemperature,
      plannedTarget: isTemperaturePlanDevice(device)
        ? device.plannedTarget
        : evidence.value.currentTarget,
      thermalDirection,
    },
  };
}

import type { PlannedTemperatureState } from '../../packages/shared-domain/src/plannedTemperatureState';
import type { ObservedTemperatureRead } from '../observer/observedDeviceStateProjection';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import type { DevicePlan } from './planTypes';

export type OverviewTemperatureFacet =
  | { kind: 'present'; value: PlannedTemperatureState }
  | { kind: 'absent' };

/**
 * Builds the one temperature facet used by every overview carrier.
 *
 * The observer owns the current pair and the planner owns `plannedTarget`.
 * Evidence is discriminated before it enters this resolver: consumers never
 * reinterpret nullable transport values or infer why an observation is absent.
 */
export function resolveOverviewTemperatureFacet(
  device: DevicePlan['devices'][number],
  evidence: ObservedTemperatureRead,
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
    },
  };
}

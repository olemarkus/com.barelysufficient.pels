import type { LifecycleFallbackDevice } from '../executor/lifecycleFallbackDispatcher';
import type { LifecycleFallbackPosture } from '../executor/lifecycleFallbackRequest';
import type { ShedBehavior } from '../plan/planTypes';
import {
  getSteppedLoadLowestActiveStep, getSteppedLoadOffStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';

/**
 * Select the configured target, binary off, or the lowest active/off step.
 * A managed thermostat with temperature control disabled and no binary axis
 * legitimately has no writable axis. Return that state so lifecycle handling
 * can retry within its grace period without aborting other devices' ticks.
 */
export const resolveFallbackPosture = (
  device: LifecycleFallbackDevice,
  configured: ShedBehavior,
): LifecycleFallbackPosture => {
  if (device.targetAxis.state === 'writable' && configured.action === 'set_temperature') {
    return { kind: 'target', temperature: configured.temperature };
  }
  if (device.binaryAxis.state === 'writable') return { kind: 'binary_off' };
  if (device.stepAxis.state === 'writable') {
    const { profile } = device.stepAxis;
    const step = getSteppedLoadLowestActiveStep(profile) ?? getSteppedLoadOffStep(profile);
    if (step) return { kind: 'step', profile, stepId: step.id };
  }
  return { kind: 'no_writable_axis' };
};


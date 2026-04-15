import type { SteppedLoadProfile } from '../utils/types';
import { resolveSteppedLoadCurrentState } from './planSteppedLoad';

type ObservedCurrentStateInput = {
  currentOn: boolean;
  hasBinaryControl?: boolean;
  observationStale?: boolean;
  controlModel?: string;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
};

export function resolveObservedCurrentState(device: ObservedCurrentStateInput): string {
  if (device.observationStale === true) {
    return device.hasBinaryControl === false ? 'not_applicable' : 'unknown';
  }

  if (device.controlModel === 'stepped_load' && device.steppedLoadProfile) {
    const steppedState = resolveSteppedLoadCurrentState({
      controlModel: 'stepped_load',
      steppedLoadProfile: device.steppedLoadProfile,
      selectedStepId: device.selectedStepId,
      currentOn: device.currentOn,
    });
    if (steppedState !== 'unknown') return steppedState;
  }

  if (device.hasBinaryControl === false) {
    return 'not_applicable';
  }

  return device.currentOn ? 'on' : 'off';
}

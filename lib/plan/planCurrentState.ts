import { getSteppedLoadStep, isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import type { DeviceControlModel, SteppedLoadProfile } from '../utils/types';

export type PlannerCurrentStateSource = 'binary' | 'stepped' | 'target' | 'unknown';
export type PlannerPendingInfluence = 'none' | 'present_but_not_applied';

export type ResolvedCurrentState = {
  currentState: string;
  isOn: boolean | null;
  source: PlannerCurrentStateSource;
  reasonCode: string;
  pendingInfluence: PlannerPendingInfluence;
};

type ObservedCurrentStateInput = {
  currentOn: boolean;
  hasBinaryControl?: boolean;
  observationStale?: boolean;
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
};

type CurrentStateInput = Partial<ObservedCurrentStateInput> & {
  currentState?: string;
};

type ResolveCurrentStateOptions = {
  pendingPresent?: boolean;
};

type StepCurrentStateInput = Pick<
  ObservedCurrentStateInput,
  'controlModel' | 'steppedLoadProfile' | 'selectedStepId'
> & { currentOn: boolean };

const isSteppedLoadObservation = (
  device: Pick<CurrentStateInput, 'controlModel' | 'steppedLoadProfile'>,
): boolean => (
  device.controlModel === 'stepped_load' && device.steppedLoadProfile?.model === 'stepped_load'
);

function resolvePendingInfluence(
  options?: ResolveCurrentStateOptions,
): PlannerPendingInfluence {
  return options?.pendingPresent === true ? 'present_but_not_applied' : 'none';
}

function resolveObservedCurrentStateValue(device: CurrentStateInput): string {
  if (typeof device.currentState === 'string') return device.currentState;
  if (typeof device.currentOn === 'boolean') {
    return resolveObservedCurrentState(device as ObservedCurrentStateInput);
  }
  return 'unknown';
}

export function resolveObservedSteppedLoadCurrentState(
  device: StepCurrentStateInput,
): string {
  const profile = isSteppedLoadObservation(device) ? device.steppedLoadProfile ?? null : null;
  if (!profile) {
    return device.currentOn ? 'on' : 'off';
  }
  if (device.currentOn === false) return 'off';
  if (!device.selectedStepId) return 'unknown';

  const selectedStep = getSteppedLoadStep(profile, device.selectedStepId);
  if (!selectedStep) return 'unknown';
  return isSteppedLoadOffStep(profile, selectedStep.id) ? 'off' : 'on';
}

export function resolveObservedCurrentState(
  device: ObservedCurrentStateInput,
): string {
  if (device.observationStale === true) {
    return device.hasBinaryControl === false ? 'not_applicable' : 'unknown';
  }

  if (isSteppedLoadObservation(device) && device.steppedLoadProfile) {
    const steppedState = resolveObservedSteppedLoadCurrentState({
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

function buildBinaryResolvedCurrentState(params: {
  currentState: 'on' | 'off';
  stepped: boolean;
  pendingInfluence: PlannerPendingInfluence;
}): ResolvedCurrentState {
  const { currentState, stepped, pendingInfluence } = params;
  const isOn = currentState === 'on';
  let reasonCode = isOn ? 'observed_binary_on' : 'observed_binary_off';
  if (stepped) {
    reasonCode = isOn ? 'observed_step_active' : 'observed_step_off';
  }
  return {
    currentState,
    isOn,
    source: stepped ? 'stepped' : 'binary',
    reasonCode,
    pendingInfluence,
  };
}

function buildNotApplicableResolvedCurrentState(params: {
  currentState: 'not_applicable';
  currentOn?: boolean;
  pendingInfluence: PlannerPendingInfluence;
}): ResolvedCurrentState {
  const { currentState, currentOn, pendingInfluence } = params;
  if (typeof currentOn === 'boolean') {
    return {
      currentState,
      isOn: currentOn,
      source: 'binary',
      reasonCode: currentOn ? 'observed_binary_on_not_applicable' : 'observed_binary_off_not_applicable',
      pendingInfluence,
    };
  }
  return {
    currentState,
    isOn: null,
    source: 'target',
    reasonCode: 'observed_target_only',
    pendingInfluence,
  };
}

export function resolveEffectiveCurrentState(
  device: CurrentStateInput,
  options?: ResolveCurrentStateOptions,
): ResolvedCurrentState {
  const currentState = resolveObservedCurrentStateValue(device);
  const pendingInfluence = resolvePendingInfluence(options);
  const stepped = isSteppedLoadObservation(device);

  if (currentState === 'on' || currentState === 'off') {
    return buildBinaryResolvedCurrentState({ currentState, stepped, pendingInfluence });
  }

  if (currentState === 'not_applicable') {
    return buildNotApplicableResolvedCurrentState({
      currentState,
      currentOn: device.currentOn,
      pendingInfluence,
    });
  }

  return {
    currentState,
    isOn: null,
    source: 'unknown',
    reasonCode: currentState === 'unknown' ? 'observed_state_unknown' : 'observed_state_unrecognized',
    pendingInfluence,
  };
}

export function resolveEffectiveCurrentOn(
  device: CurrentStateInput,
  options?: ResolveCurrentStateOptions,
): boolean | null {
  return resolveEffectiveCurrentState(device, options).isOn;
}

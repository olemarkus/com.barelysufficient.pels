import {
  getSteppedLoadLowestActiveStep,
  normalizeSteppedLoadProfile,
  sortSteppedLoadSteps,
} from '../../../../contracts/src/deviceControlProfiles.ts';
import type { SteppedLoadProfile, TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import {
  deviceDetailShedAction,
  deviceDetailSteppedAddStep,
  deviceDetailSteppedReset,
  deviceDetailSteppedSave,
  deviceDetailSteppedSection,
  deviceDetailSteppedSteps,
} from '../dom.ts';
import {
  createDefaultSteppedLoadProfile,
  getEffectiveControlModel,
  getStoredDeviceControlProfile,
  isNativeSteppedLoadProfileActive,
} from '../deviceControlProfiles.ts';
import { logSettingsError } from '../logging.ts';
import { state } from '../state.ts';
import { showToastError } from '../toast.ts';
import { writeShedBehaviors } from './shedBehavior.ts';

let currentSteppedLoadDraft: SteppedLoadProfile | null = null;

const DEFAULT_SET_STEP_OPTION_LABEL = 'Set to step';

const getSetStepOption = (): HTMLOptionElement | null => (
  deviceDetailShedAction?.querySelector<HTMLOptionElement>('option[value="set_step"]') ?? null
);

const attachDraftSyncOnChange = (
  onDraftChanged: () => void,
  ...inputs: HTMLInputElement[]
) => {
  inputs.forEach((input) => {
    input.addEventListener('change', onDraftChanged);
  });
};

const getDraftProfileFromCurrentDevice = (device: TargetDeviceSnapshot): SteppedLoadProfile => (
  isNativeSteppedLoadProfileActive(device)
    ? createDefaultSteppedLoadProfile(device)
    : currentSteppedLoadDraft
      ?? resolveSavedSteppedLoadProfile(device)
      ?? createDefaultSteppedLoadProfile(device)
);

const collectSteppedLoadDraftFromDom = (): SteppedLoadProfile | null => {
  if (!deviceDetailSteppedSteps) return null;

  const rows = Array.from(deviceDetailSteppedSteps.querySelectorAll<HTMLElement>('[data-step-row="true"]'));
  const steps = rows.map((row) => {
    const readValue = (field: string) => (
      row.querySelector<HTMLInputElement>(`[data-step-field="${field}"]`)?.value?.trim() ?? ''
    );
    return {
      id: readValue('id'),
      planningPowerW: Number.parseFloat(readValue('planningPowerW')),
    };
  });

  return normalizeSteppedLoadProfile({
    model: 'stepped_load',
    steps,
  }) ?? null;
};

const buildSteppedLoadStepRow = (params: {
  step: SteppedLoadProfile['steps'][number];
  onDraftChanged: () => void;
  disabled?: boolean;
}): HTMLElement => {
  const row = document.createElement('div');
  row.className = 'device-row detail-stepped-row';
  row.dataset.stepRow = 'true';

  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.value = params.step.id;
  idInput.dataset.stepField = 'id';
  idInput.placeholder = 'step';
  idInput.disabled = params.disabled === true;
  idInput.setAttribute('aria-label', 'Step id');

  const planningInput = document.createElement('input');
  planningInput.type = 'number';
  planningInput.step = '50';
  planningInput.min = '0';
  planningInput.value = String(params.step.planningPowerW);
  planningInput.dataset.stepField = 'planningPowerW';
  planningInput.placeholder = '0';
  planningInput.disabled = params.disabled === true;
  planningInput.setAttribute('aria-label', 'Planning power in watts');

  attachDraftSyncOnChange(params.onDraftChanged, idInput, planningInput);

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'btn ghost';
  removeButton.textContent = 'Remove';
  removeButton.disabled = params.disabled === true;
  removeButton.setAttribute('aria-label', `Remove step ${params.step.id}`);
  removeButton.addEventListener('click', () => {
    row.remove();
    params.onDraftChanged();
  });

  row.append(idInput, planningInput, removeButton);
  return row;
};

export const isSteppedLoadControlModel = (device: TargetDeviceSnapshot | null): boolean => (
  Boolean(device && getEffectiveControlModel(device) === 'stepped_load')
);

export const resolveSavedSteppedLoadProfile = (device: TargetDeviceSnapshot): SteppedLoadProfile | null => {
  const stored = getStoredDeviceControlProfile(device.id);
  if (stored?.model === 'stepped_load') return stored;
  return device.steppedLoadProfile?.model === 'stepped_load' ? device.steppedLoadProfile : null;
};

export const updateSetStepOptionLabel = (
  device: TargetDeviceSnapshot | null,
  profileOverride?: SteppedLoadProfile | null,
) => {
  const setStepOption = getSetStepOption();
  if (!setStepOption) return;

  if (!device || !isSteppedLoadControlModel(device)) {
    setStepOption.textContent = DEFAULT_SET_STEP_OPTION_LABEL;
    return;
  }

  const profile = profileOverride
    ?? currentSteppedLoadDraft
    ?? resolveSavedSteppedLoadProfile(device);
  const lowestActiveStepId = profile ? getSteppedLoadLowestActiveStep(profile)?.id : null;
  setStepOption.textContent = lowestActiveStepId
    ? `Set to step "${lowestActiveStepId}"`
    : DEFAULT_SET_STEP_OPTION_LABEL;
};

export const renderSteppedLoadDraft = (device: TargetDeviceSnapshot) => {
  if (!deviceDetailSteppedSection || !deviceDetailSteppedSteps) return;

  const steppedEnabled = isSteppedLoadControlModel(device);
  deviceDetailSteppedSection.hidden = !steppedEnabled;
  if (!steppedEnabled) {
    currentSteppedLoadDraft = null;
    deviceDetailSteppedSteps.replaceChildren();
    if (deviceDetailSteppedAddStep) deviceDetailSteppedAddStep.disabled = false;
    if (deviceDetailSteppedReset) deviceDetailSteppedReset.disabled = false;
    if (deviceDetailSteppedSave) deviceDetailSteppedSave.disabled = false;
    updateSetStepOptionLabel(device, null);
    return;
  }

  const nativeProfileLocked = isNativeSteppedLoadProfileActive(device);
  if (deviceDetailSteppedAddStep) deviceDetailSteppedAddStep.disabled = nativeProfileLocked;
  if (deviceDetailSteppedReset) deviceDetailSteppedReset.disabled = nativeProfileLocked;
  if (deviceDetailSteppedSave) deviceDetailSteppedSave.disabled = nativeProfileLocked;

  const syncSteppedLoadDraftState = () => {
    if (nativeProfileLocked) return;
    const profile = collectSteppedLoadDraftFromDom()
      ?? currentSteppedLoadDraft
      ?? getDraftProfileFromCurrentDevice(device);
    currentSteppedLoadDraft = profile;
    updateSetStepOptionLabel(device, profile);
  };

  const profile = getDraftProfileFromCurrentDevice(device);
  currentSteppedLoadDraft = profile;
  updateSetStepOptionLabel(device, profile);
  const rows = sortSteppedLoadSteps(profile.steps).map((step) => buildSteppedLoadStepRow({
    step,
    onDraftChanged: syncSteppedLoadDraftState,
    disabled: nativeProfileLocked,
  }));
  deviceDetailSteppedSteps.replaceChildren(...rows);
};

export const closeSteppedLoadDraft = () => {
  currentSteppedLoadDraft = null;
};

export const initSteppedLoadDraftHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
  persistDeviceControlProfile: (deviceId: string, profile: SteppedLoadProfile | null) => Promise<boolean>;
  refreshOpenDeviceDetail: () => void;
}) => {
  const appendDraftSteppedLoadStep = () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;

    const device = params.getDeviceById(deviceId);
    if (!device) return;
    if (isNativeSteppedLoadProfileActive(device)) return;

    const profile = collectSteppedLoadDraftFromDom()
      ?? currentSteppedLoadDraft
      ?? getDraftProfileFromCurrentDevice(device);
    const existingIds = new Set(profile.steps.map((step) => step.id));
    let nextIndex = profile.steps.length + 1;
    let nextId = `step_${nextIndex}`;
    while (existingIds.has(nextId)) {
      nextIndex += 1;
      nextId = `step_${nextIndex}`;
    }

    const lastPower = profile.steps[profile.steps.length - 1]?.planningPowerW ?? 0;
    currentSteppedLoadDraft = {
      ...profile,
      steps: [...profile.steps, {
        id: nextId,
        planningPowerW: lastPower,
      }],
    };
    renderSteppedLoadDraft(device);
  };

  const resetSteppedLoadDraft = () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;

    const device = params.getDeviceById(deviceId);
    if (!device) return;
    if (isNativeSteppedLoadProfileActive(device)) return;

    currentSteppedLoadDraft = resolveSavedSteppedLoadProfile(device) ?? createDefaultSteppedLoadProfile(device);
    renderSteppedLoadDraft(device);
  };

  const saveSteppedLoadProfile = async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;

    const device = params.getDeviceById(deviceId);
    if (!device) return;
    if (isNativeSteppedLoadProfileActive(device)) return;

    const profile = collectSteppedLoadDraftFromDom();
    if (!profile) {
      throw new Error(
        'Complete the stepped-load profile before saving. '
        + 'Each step needs a unique id and valid planning power.',
      );
    }

    currentSteppedLoadDraft = profile;
    if (deviceDetailShedAction && deviceDetailShedAction.value === 'set_step') {
      const lowestActiveStepId = getSteppedLoadLowestActiveStep(profile)?.id;
      const nextBehaviors = await writeShedBehaviors({
        context: 'device detail',
        logMessage: 'Failed to save stepped-load profile',
        toastMessage: 'Failed to save stepped-load profile.',
        mutate: (currentBehaviors) => {
          const currentBehavior = currentBehaviors[deviceId];
          if (currentBehavior?.action !== 'set_step') {
            return currentBehaviors;
          }
          return {
            ...currentBehaviors,
            [deviceId]: lowestActiveStepId ? { action: 'set_step' } : { action: 'turn_off' },
          };
        },
        commit: (nextBehaviors) => {
          state.shedBehaviors = nextBehaviors;
        },
      });
      if (!nextBehaviors) return;
    }

    const didPersist = await params.persistDeviceControlProfile(deviceId, profile);
    if (didPersist) {
      params.refreshOpenDeviceDetail();
    }
  };

  deviceDetailSteppedAddStep?.addEventListener('click', appendDraftSteppedLoadStep);
  deviceDetailSteppedReset?.addEventListener('click', resetSteppedLoadDraft);
  deviceDetailSteppedSave?.addEventListener('click', async () => {
    try {
      await saveSteppedLoadProfile();
    } catch (error) {
      await logSettingsError('Failed to save stepped-load profile', error, 'device detail');
      await showToastError(error, 'Failed to save stepped-load profile.');
    }
  });
};

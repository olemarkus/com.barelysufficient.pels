import {
  getSteppedLoadLowestActiveStep,
  normalizeSteppedLoadProfile,
  sortSteppedLoadSteps,
} from '../../../../contracts/src/deviceControlProfiles.ts';
import type { SteppedLoadProfile } from '../../../../contracts/src/types.ts';
import { formatStepDisplayLabel } from '../../../../shared-domain/src/planSteppedCardText.ts';
import {
  supportsTemperatureControlDevice,
  supportsTemperatureDevice,
  type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
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
  getStoredDeviceControlProfile,
  isNativeSteppedLoadProfileActive,
} from '../deviceControlProfiles.ts';
import { logSettingsError } from '../logging.ts';
import { state } from '../state.ts';
import { showToastError } from '../toast.ts';
import { hasEvTargetPowerPreset, isSteppedLoadControlModel } from '../deviceKind.ts';
import { supportsEvBoostDevice } from './evBoost.ts';
import { writeShedBehaviors } from './shedBehavior.ts';

// Drafts are keyed by deviceId so the editor state for one device cannot bleed
// into another's session. A single module-global draft used to make fallback
// chains depend on whichever device wrote the draft last (TODO 740).
const steppedLoadDraftsByDeviceId = new Map<string, SteppedLoadProfile>();

const getSteppedLoadDraft = (deviceId: string): SteppedLoadProfile | null => (
  steppedLoadDraftsByDeviceId.get(deviceId) ?? null
);

const setSteppedLoadDraft = (deviceId: string, profile: SteppedLoadProfile): void => {
  steppedLoadDraftsByDeviceId.set(deviceId, profile);
};

const clearSteppedLoadDraft = (deviceId: string): void => {
  steppedLoadDraftsByDeviceId.delete(deviceId);
};

const DEFAULT_SET_STEP_OPTION_LABEL = 'Set to step';

type MaterialSelectOptionElement = HTMLElement & { value: string };

const getSetStepOption = (): MaterialSelectOptionElement | null => (
  deviceDetailShedAction?.querySelector<MaterialSelectOptionElement>(
    'md-select-option[value="set_step"]',
  ) ?? null
);

const getOptionLabel = (option: MaterialSelectOptionElement): string => (
  option.querySelector<HTMLElement>('[slot="headline"]')?.textContent ?? option.textContent ?? ''
);

const setOptionLabel = (option: MaterialSelectOptionElement, label: string): void => {
  const headline = option.querySelector<HTMLElement>('[slot="headline"]');
  if (headline) {
    headline.textContent = label;
    return;
  }
  const nextHeadline = document.createElement('div');
  nextHeadline.slot = 'headline';
  nextHeadline.textContent = label;
  option.replaceChildren(nextHeadline);
};

const attachDraftSyncOnChange = (
  onDraftChanged: () => void,
  ...inputs: HTMLElement[]
) => {
  inputs.forEach((input) => {
    input.addEventListener('change', onDraftChanged);
    input.addEventListener('input', onDraftChanged);
  });
};

const getDraftProfileFromCurrentDevice = (device: SettingsUiDeviceDetailItem): SteppedLoadProfile => (
  isNativeSteppedLoadProfileActive(device)
    ? createDefaultSteppedLoadProfile(device)
    : getSteppedLoadDraft(device.id)
      ?? resolveSavedSteppedLoadProfile(device)
      ?? createDefaultSteppedLoadProfile(device)
);

const canEditSteppedLoadProfile = (device: SettingsUiDeviceDetailItem): boolean => !hasEvTargetPowerPreset(device);

const collectSteppedLoadDraftFromDom = (): SteppedLoadProfile | null => {
  if (!deviceDetailSteppedSteps) return null;

  const rows = Array.from(deviceDetailSteppedSteps.querySelectorAll<HTMLElement>('[data-step-row="true"]'));
  const steps = rows.map((row) => {
    const readValue = (field: string) => {
      const el = row.querySelector(`[data-step-field="${field}"]`) as (HTMLElement & { value?: string }) | null;
      return el?.value?.trim() ?? '';
    };
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

const steppedStepsSignature = (profile: SteppedLoadProfile): string => JSON.stringify(
  sortSteppedLoadSteps(profile.steps).map((step) => [step.id.trim().toLowerCase(), step.planningPowerW]),
);

// The stepped editor is "dirty" when the on-screen rows differ from the saved
// profile (or when the draft is incomplete — i.e. mid-edit). This gates the
// Save/Undo actions so Save is inert until the user has actually changed something.
const isSteppedDraftDirty = (device: SettingsUiDeviceDetailItem): boolean => {
  const current = collectSteppedLoadDraftFromDom();
  if (!current) return true;
  const saved = resolveSavedSteppedLoadProfile(device) ?? createDefaultSteppedLoadProfile(device);
  return steppedStepsSignature(current) !== steppedStepsSignature(saved);
};

// Muted trash icon at rest; the error tone only surfaces on hover/focus/press
// (see `.detail-stepped-remove` in style.css) so a full profile is not a wall
// of red "Remove" links.
const buildSteppedRemoveButton = (params: {
  stepId: string;
  disabled: boolean;
  onRemove: () => void;
}): HTMLElement => {
  const removeButton = document.createElement('md-icon-button') as HTMLElement & { disabled: boolean };
  removeButton.classList.add('detail-stepped-remove');
  removeButton.disabled = params.disabled;
  removeButton.setAttribute('aria-label', `Remove step ${params.stepId}`);
  const trashTemplate = document.getElementById('pels-icon-trash') as HTMLTemplateElement | null;
  if (trashTemplate) {
    removeButton.appendChild(trashTemplate.content.cloneNode(true));
  }
  removeButton.addEventListener('click', params.onRemove);
  return removeButton;
};

const buildSteppedLoadStepRow = (params: {
  step: SteppedLoadProfile['steps'][number];
  onDraftChanged: () => void;
  disabled?: boolean;
}): HTMLElement => {
  const row = document.createElement('div');
  row.className = 'device-row detail-stepped-row';
  row.dataset.stepRow = 'true';
  const disabled = params.disabled === true;

  // Per-row field labels are dropped in favour of the shared column headers
  // (`.detail-stepped-header`) so each row reads value-first. The step column
  // uses a placeholder for the empty state; the power column keeps its unit
  // as a trailing in-field suffix (never doubled in the "Power" header).
  const idInput = document.createElement('md-filled-text-field') as HTMLElement & {
    value: string; disabled: boolean;
  };
  idInput.setAttribute('placeholder', 'Step');
  idInput.setAttribute('aria-label', 'Step');
  idInput.value = params.step.id;
  idInput.dataset.stepField = 'id';
  idInput.disabled = disabled;

  const planningInput = document.createElement('md-filled-text-field') as HTMLElement & {
    value: string; disabled: boolean;
  };
  planningInput.setAttribute('placeholder', 'Power');
  planningInput.setAttribute('aria-label', 'Step power');
  planningInput.setAttribute('type', 'number');
  planningInput.setAttribute('step', '50');
  planningInput.setAttribute('min', '0');
  planningInput.setAttribute('inputmode', 'numeric');
  planningInput.setAttribute('suffix-text', 'W');
  planningInput.value = String(params.step.planningPowerW);
  planningInput.dataset.stepField = 'planningPowerW';
  planningInput.disabled = disabled;

  attachDraftSyncOnChange(params.onDraftChanged, idInput, planningInput);

  const removeButton = buildSteppedRemoveButton({
    stepId: params.step.id,
    disabled,
    onRemove: () => {
      row.remove();
      params.onDraftChanged();
    },
  });

  row.append(idInput, planningInput, removeButton);
  return row;
};

export const resolveSavedSteppedLoadProfile = (device: SettingsUiDeviceDetailItem): SteppedLoadProfile | null => {
  const stored = getStoredDeviceControlProfile(device.id);
  if (stored?.model === 'stepped_load') return stored;
  return device.steppedLoadProfile?.model === 'stepped_load' ? device.steppedLoadProfile : null;
};

export const updateSetStepOptionLabel = (
  device: SettingsUiDeviceDetailItem | null,
  profileOverride?: SteppedLoadProfile | null,
) => {
  const setStepOption = getSetStepOption();
  if (!setStepOption) return;

  const previousLabel = getOptionLabel(setStepOption);

  if (!device || !isSteppedLoadControlModel(device)) {
    setOptionLabel(setStepOption, DEFAULT_SET_STEP_OPTION_LABEL);
    setStepOption.setAttribute('data-short-label', 'Step');
  } else {
    const profile = profileOverride
      ?? getSteppedLoadDraft(device.id)
      ?? resolveSavedSteppedLoadProfile(device);
    const lowestActiveStepId = profile ? getSteppedLoadLowestActiveStep(profile)?.id : null;
    // Format the id through the same helper the Overview uses (`6a` → `6 A`,
    // the editor's default `step_2` → `Step 2`) so an internal token never
    // surfaces raw, and drop the quotes.
    setOptionLabel(setStepOption, lowestActiveStepId
      ? `Set to ${formatStepDisplayLabel(lowestActiveStepId)}`
      : DEFAULT_SET_STEP_OPTION_LABEL);
    setStepOption.setAttribute(
      'data-short-label',
      lowestActiveStepId ? formatStepDisplayLabel(lowestActiveStepId) : 'Step',
    );
  }

  if (previousLabel !== getOptionLabel(setStepOption)) {
    deviceDetailShedAction?.dispatchEvent(new Event('pels:segmented-refresh'));
  }
};

export const renderSteppedLoadDraft = (device: SettingsUiDeviceDetailItem) => {
  if (!deviceDetailSteppedSection || !deviceDetailSteppedSteps) return;

  const temperatureControlAvailable = !supportsTemperatureDevice(device)
    || supportsTemperatureControlDevice(device);
  const showStepEditor = temperatureControlAvailable && isSteppedLoadControlModel(device);
  const showBoostOnlySection = supportsEvBoostDevice(device);
  const setEditorVisibility = (hidden: boolean) => {
    deviceDetailSteppedSteps.hidden = hidden;
    if (deviceDetailSteppedAddStep) deviceDetailSteppedAddStep.hidden = hidden;
    if (deviceDetailSteppedReset) deviceDetailSteppedReset.hidden = hidden;
    if (deviceDetailSteppedSave) deviceDetailSteppedSave.hidden = hidden;
  };
  const setEditorDisabled = (disabled: boolean) => {
    if (deviceDetailSteppedAddStep) deviceDetailSteppedAddStep.disabled = disabled;
    if (deviceDetailSteppedReset) deviceDetailSteppedReset.disabled = disabled;
    if (deviceDetailSteppedSave) deviceDetailSteppedSave.disabled = disabled;
  };
  deviceDetailSteppedSection.hidden = !showStepEditor && !showBoostOnlySection;
  setEditorVisibility(!showStepEditor);
  if (!showStepEditor) {
    clearSteppedLoadDraft(device.id);
    deviceDetailSteppedSteps.replaceChildren();
    setEditorDisabled(false);
    updateSetStepOptionLabel(device, null);
    return;
  }

  const nativeProfileLocked = isNativeSteppedLoadProfileActive(device);
  // Add-step stays available while the profile is editable; Save/Undo gate on
  // whether the draft actually differs from the saved profile so Save reads as
  // tonal-and-inert until the user has made a real edit.
  if (deviceDetailSteppedAddStep) deviceDetailSteppedAddStep.disabled = nativeProfileLocked;

  const refreshEditorDirtyState = () => {
    const dirty = !nativeProfileLocked && isSteppedDraftDirty(device);
    if (deviceDetailSteppedReset) deviceDetailSteppedReset.disabled = !dirty;
    if (deviceDetailSteppedSave) deviceDetailSteppedSave.disabled = !dirty;
  };

  const syncSteppedLoadDraftState = () => {
    if (nativeProfileLocked) return;
    const profile = collectSteppedLoadDraftFromDom()
      ?? getSteppedLoadDraft(device.id)
      ?? getDraftProfileFromCurrentDevice(device);
    setSteppedLoadDraft(device.id, profile);
    updateSetStepOptionLabel(device, profile);
    refreshEditorDirtyState();
  };

  const profile = getDraftProfileFromCurrentDevice(device);
  setSteppedLoadDraft(device.id, profile);
  updateSetStepOptionLabel(device, profile);
  const rows = sortSteppedLoadSteps(profile.steps).map((step) => buildSteppedLoadStepRow({
    step,
    onDraftChanged: syncSteppedLoadDraftState,
    disabled: nativeProfileLocked,
  }));
  deviceDetailSteppedSteps.replaceChildren(...rows);
  refreshEditorDirtyState();
};

// Drop the closing device's draft so its next open starts fresh from the persisted
// profile. Drafts for any other device the user has touched remain intact — the
// per-device map shipped in TODO 740 explicitly advertises that isolation guarantee,
// and a blanket .clear() here used to erase unsaved edits on every other device when
// the user merely switched panes.
export const closeSteppedLoadDraft = (deviceId: string): void => {
  if (!deviceId) return;
  steppedLoadDraftsByDeviceId.delete(deviceId);
};

export const initSteppedLoadDraftHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
  persistDeviceControlProfile: (deviceId: string, profile: SteppedLoadProfile | null) => Promise<boolean>;
  refreshOpenDeviceDetail: () => void;
}) => {
  const appendDraftSteppedLoadStep = () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;

    const device = params.getDeviceById(deviceId);
    if (!device) return;
    if (!canEditSteppedLoadProfile(device)) return;
    if (isNativeSteppedLoadProfileActive(device)) return;

    const profile = collectSteppedLoadDraftFromDom()
      ?? getSteppedLoadDraft(deviceId)
      ?? getDraftProfileFromCurrentDevice(device);
    const existingIds = new Set(profile.steps.map((step) => step.id));
    let nextIndex = profile.steps.length + 1;
    let nextId = `step_${nextIndex}`;
    while (existingIds.has(nextId)) {
      nextIndex += 1;
      nextId = `step_${nextIndex}`;
    }

    const lastPower = profile.steps[profile.steps.length - 1]?.planningPowerW ?? 0;
    setSteppedLoadDraft(deviceId, {
      ...profile,
      steps: [...profile.steps, {
        id: nextId,
        planningPowerW: lastPower,
      }],
    });
    renderSteppedLoadDraft(device);
  };

  const resetSteppedLoadDraft = () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;

    const device = params.getDeviceById(deviceId);
    if (!device) return;
    if (!canEditSteppedLoadProfile(device)) return;
    if (isNativeSteppedLoadProfileActive(device)) return;

    setSteppedLoadDraft(
      deviceId,
      resolveSavedSteppedLoadProfile(device) ?? createDefaultSteppedLoadProfile(device),
    );
    renderSteppedLoadDraft(device);
  };

  const saveSteppedLoadProfile = async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;

    const device = params.getDeviceById(deviceId);
    if (!device) return;
    if (!canEditSteppedLoadProfile(device)) return;
    if (isNativeSteppedLoadProfileActive(device)) return;

    const profile = collectSteppedLoadDraftFromDom();
    if (!profile) {
      throw new Error(
        'Complete the stepped-load profile before saving. '
        + 'Each step needs a unique id and valid planning power.',
      );
    }

    setSteppedLoadDraft(deviceId, profile);
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

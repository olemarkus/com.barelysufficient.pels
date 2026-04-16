import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import {
  deviceDetailShedAction,
  deviceDetailShedStep,
  deviceDetailShedStepRow,
  deviceDetailShedTemp,
  deviceDetailShedTempRow,
} from '../dom.ts';
import { getSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { state } from '../state.ts';
import {
  supportsPowerDevice,
  supportsTemperatureDevice,
} from '../deviceUtils.ts';
import {
  AIRTREATMENT_SHED_FLOOR_C,
  NON_ONOFF_TEMPERATURE_SHED_FLOOR_C,
} from '../../../../shared-domain/src/utils/airtreatmentConstants.ts';
import {
  OVERSHOOT_BEHAVIORS,
} from '../../../../contracts/src/settingsKeys.ts';
import {
  computeDefaultAirtreatmentShedTemperature,
  normalizeShedTemperature,
} from '../../../../shared-domain/src/utils/airtreatmentShedTemperature.ts';
import { createSerializedAsyncRunner, readRecordSetting, writeFreshSetting } from './settingsWrite.ts';

export type ShedAction = 'turn_off' | 'set_temperature' | 'set_step';

export type PersistedShedBehavior = {
  action: ShedAction;
  temperature?: number;
  stepId?: string;
};

type ShedBehaviorWriteParams = {
  context: string;
  logMessage: string;
  toastMessage: string;
  mutate: (currentBehaviors: Record<string, PersistedShedBehavior>) => Record<string, PersistedShedBehavior>;
  commit?: (nextBehaviors: Record<string, PersistedShedBehavior>) => Promise<void> | void;
  rollback?: () => Promise<void> | void;
};

export const readShedBehaviors = (value: unknown, fallbackValue: Record<string, PersistedShedBehavior> = {}) => (
  readRecordSetting<PersistedShedBehavior>(value, fallbackValue)
);

const runSerializedShedBehaviorWrite = createSerializedAsyncRunner();

export const writeShedBehaviors = async (params: ShedBehaviorWriteParams) => (
  runSerializedShedBehaviorWrite(() => writeFreshSetting<Record<string, PersistedShedBehavior>>({
    key: OVERSHOOT_BEHAVIORS,
    context: params.context,
    logMessage: params.logMessage,
    toastMessage: params.toastMessage,
    fallbackValue: {},
    readFresh: readShedBehaviors,
    mutate: params.mutate,
    commit: params.commit,
    rollback: params.rollback,
  }))
);

const isTemperatureDeviceWithoutOnOff = (device: TargetDeviceSnapshot | null): boolean => (
  Boolean(
    device
    && supportsTemperatureDevice(device)
    && !device.capabilities?.includes('onoff'),
  )
);

const resolveTemperatureShedFloor = (device: TargetDeviceSnapshot | null): number => {
  const classKey = (device?.deviceClass || '').trim().toLowerCase();
  return classKey === 'airtreatment' ? AIRTREATMENT_SHED_FLOOR_C : NON_ONOFF_TEMPERATURE_SHED_FLOOR_C;
};

const updateShedActionOptions = (params: {
  canConfigure: boolean;
  forceTemperatureOnly: boolean;
  forceStepOnly: boolean;
  supportsTemperature: boolean;
  supportsStep: boolean;
}): void => {
  if (!deviceDetailShedAction) return;

  const turnOffOption = deviceDetailShedAction.querySelector<HTMLOptionElement>('option[value="turn_off"]');
  const setTempOption = deviceDetailShedAction.querySelector<HTMLOptionElement>('option[value="set_temperature"]');
  const setStepOption = deviceDetailShedAction.querySelector<HTMLOptionElement>('option[value="set_step"]');

  if (turnOffOption) {
    turnOffOption.disabled = !params.canConfigure || params.forceTemperatureOnly || params.forceStepOnly;
    turnOffOption.hidden = params.forceTemperatureOnly || params.forceStepOnly;
  }
  if (setTempOption) {
    setTempOption.disabled = !params.canConfigure;
    setTempOption.hidden = !params.supportsTemperature;
  }
  if (setStepOption) {
    setStepOption.disabled = !params.canConfigure || !params.supportsStep;
    setStepOption.hidden = !params.supportsStep;
  }

  deviceDetailShedAction.disabled = !params.canConfigure || params.forceTemperatureOnly;
};

const isShedActionOptionVisible = (action: ShedAction): boolean => {
  if (!deviceDetailShedAction) return false;
  const option = deviceDetailShedAction.querySelector<HTMLOptionElement>(`option[value="${action}"]`);
  return Boolean(option && !option.hidden);
};

const resolveShedActionValue = (params: {
  canConfigure: boolean;
  forceTemperatureOnly: boolean;
  forceStepOnly: boolean;
  configuredAction: ShedAction | undefined;
}): ShedAction => {
  if (!params.canConfigure) return 'turn_off';
  if (params.forceTemperatureOnly) return 'set_temperature';
  if (params.forceStepOnly) return 'set_step';
  if (params.configuredAction === 'set_step') return 'set_step';
  return params.configuredAction || 'turn_off';
};

const resolveShedTemperatureValue = (params: {
  canConfigure: boolean;
  forceTemperatureOnly: boolean;
  configuredTemperature: number | undefined;
  fallbackTemperature: number;
}): string => {
  if (!params.canConfigure) return '';
  if (typeof params.configuredTemperature === 'number') return params.configuredTemperature.toString();
  if (params.forceTemperatureOnly) return params.fallbackTemperature.toString();
  return '';
};

const getShedDefaultTemp = (
  deviceId: string | null,
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null,
): number => {
  if (!deviceId) return 10;

  const device = getDeviceById(deviceId);
  const modeTarget = state.modeTargets[state.activeMode]?.[deviceId]
    ?? state.modeTargets[state.editingMode]?.[deviceId];
  const normalizedModeTarget = typeof modeTarget === 'number' ? modeTarget : null;
  const currentTarget = typeof device?.targets?.[0]?.value === 'number'
    ? device.targets[0].value
    : null;

  if (isTemperatureDeviceWithoutOnOff(device)) {
    return computeDefaultAirtreatmentShedTemperature({
      modeTarget: normalizedModeTarget,
      currentTarget,
      minFloorC: resolveTemperatureShedFloor(device),
    });
  }

  if (normalizedModeTarget !== null) return normalizedModeTarget;
  if (currentTarget !== null) return currentTarget;
  return 10;
};

const parseShedTemperatureInput = (): number | null => {
  const parsedTemp = Number.parseFloat(deviceDetailShedTemp?.value || '');
  if (!Number.isFinite(parsedTemp)) return null;
  if (parsedTemp < -20 || parsedTemp > 50) return null;
  return parsedTemp;
};

const resolveTemperatureShedBehavior = (params: {
  deviceId: string;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
}): {
  behavior: PersistedShedBehavior;
  updateTempInput?: number;
} => {
  const device = params.getDeviceById(params.deviceId);
  const forceTemperatureOnly = isTemperatureDeviceWithoutOnOff(device);
  const action: ShedAction = forceTemperatureOnly || deviceDetailShedAction?.value === 'set_temperature'
    ? 'set_temperature'
    : 'turn_off';

  if (action === 'turn_off') {
    return { behavior: { action: 'turn_off' } };
  }

  const parsedTemp = parseShedTemperatureInput();
  let temperature = parsedTemp
    ?? state.shedBehaviors[params.deviceId]?.temperature
    ?? getShedDefaultTemp(params.deviceId, params.getDeviceById);
  if (forceTemperatureOnly) {
    temperature = Math.max(resolveTemperatureShedFloor(device), normalizeShedTemperature(temperature));
  }

  const shouldUpdateTempInput = parsedTemp === null || (forceTemperatureOnly && parsedTemp !== temperature);
  return {
    behavior: { action: 'set_temperature', temperature },
    updateTempInput: shouldUpdateTempInput ? temperature : undefined,
  };
};

const resolveVisibleShedAction = (params: {
  currentDetailDeviceId: string | null;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
  isSteppedLoadControlModel: (device: TargetDeviceSnapshot | null) => boolean;
}): ShedAction | null => {
  const device = params.currentDetailDeviceId ? params.getDeviceById(params.currentDetailDeviceId) : null;
  if (!deviceDetailShedAction || !device || !supportsPowerDevice(device)) return null;

  if (isTemperatureDeviceWithoutOnOff(device) && isShedActionOptionVisible('set_temperature')) {
    return 'set_temperature';
  }
  if (
    deviceDetailShedAction.value === 'set_step'
    && params.isSteppedLoadControlModel(device)
    && isShedActionOptionVisible('set_step')
  ) {
    return 'set_step';
  }
  if (
    deviceDetailShedAction.value === 'set_temperature'
    && supportsTemperatureDevice(device)
    && isShedActionOptionVisible('set_temperature')
  ) {
    return 'set_temperature';
  }
  return null;
};

export const loadShedBehaviors = async () => {
  try {
    const behaviors = await getSetting(OVERSHOOT_BEHAVIORS);
    state.shedBehaviors = readShedBehaviors(behaviors);
  } catch (error) {
    await logSettingsError('Failed to load shed behaviors', error, 'loadShedBehaviors');
  }
};

export const setDeviceDetailShedBehavior = (params: {
  deviceId: string;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
  isSteppedLoadControlModel: (device: TargetDeviceSnapshot | null) => boolean;
  updateSetStepOptionLabel: (device: TargetDeviceSnapshot | null) => void;
}) => {
  const device = params.getDeviceById(params.deviceId);
  params.updateSetStepOptionLabel(device);

  const supportsTemperature = supportsTemperatureDevice(device);
  const supportsPower = supportsPowerDevice(device);
  const supportsStep = params.isSteppedLoadControlModel(device);
  const canConfigure = supportsPower && (supportsTemperature || supportsStep);
  const forceTemperatureOnly = canConfigure && !supportsStep && isTemperatureDeviceWithoutOnOff(device);
  const forceStepOnly = supportsStep && !device?.capabilities?.includes('onoff');
  const shedConfig = state.shedBehaviors[params.deviceId];

  updateShedActionOptions({
    canConfigure,
    forceTemperatureOnly,
    forceStepOnly,
    supportsTemperature,
    supportsStep,
  });

  if (deviceDetailShedAction) {
    const nextAction = resolveShedActionValue({
      canConfigure,
      forceTemperatureOnly,
      forceStepOnly,
      configuredAction: shedConfig?.action,
    });
    deviceDetailShedAction.value = nextAction === 'set_step' && !supportsStep ? 'turn_off' : nextAction;
  }

  if (deviceDetailShedStep) {
    deviceDetailShedStep.innerHTML = '';
    deviceDetailShedStep.disabled = true;
  }

  if (deviceDetailShedTemp) {
    deviceDetailShedTemp.value = resolveShedTemperatureValue({
      canConfigure,
      forceTemperatureOnly,
      configuredTemperature: shedConfig?.temperature,
      fallbackTemperature: getShedDefaultTemp(params.deviceId, params.getDeviceById),
    });
    deviceDetailShedTemp.disabled = !canConfigure;
  }
};

export const updateShedFieldVisibility = (params: {
  currentDetailDeviceId: string | null;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
  isSteppedLoadControlModel: (device: TargetDeviceSnapshot | null) => boolean;
}) => {
  if (!deviceDetailShedAction || !deviceDetailShedTempRow || !deviceDetailShedStepRow) return;

  const selectedAction = resolveVisibleShedAction(params);
  if (selectedAction !== 'set_temperature') {
    deviceDetailShedTempRow.hidden = true;
    if (deviceDetailShedTemp) {
      deviceDetailShedTemp.disabled = true;
    }
  } else {
    deviceDetailShedTempRow.hidden = false;
    if (deviceDetailShedTemp) {
      deviceDetailShedTemp.disabled = false;
      if (!deviceDetailShedTemp.value) {
        const fallback = getShedDefaultTemp(params.currentDetailDeviceId, params.getDeviceById);
        deviceDetailShedTemp.value = fallback.toString();
      }
    }
  }

  deviceDetailShedStepRow.hidden = true;
};

const saveShedBehavior = async (params: {
  currentDetailDeviceId: string | null;
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
  isSteppedLoadControlModel: (device: TargetDeviceSnapshot | null) => boolean;
}) => {
  const deviceId = params.currentDetailDeviceId;
  if (!deviceId) return;

  const device = params.getDeviceById(deviceId);
  let nextBehavior: PersistedShedBehavior = { action: 'turn_off' };

  if (supportsPowerDevice(device)) {
    if (params.isSteppedLoadControlModel(device) && deviceDetailShedAction?.value === 'set_step') {
      nextBehavior = { action: 'set_step' };
    } else if (supportsTemperatureDevice(device)) {
      const { behavior, updateTempInput } = resolveTemperatureShedBehavior({
        deviceId,
        getDeviceById: params.getDeviceById,
      });
      nextBehavior = behavior;
      if (typeof updateTempInput === 'number' && deviceDetailShedTemp) {
        deviceDetailShedTemp.value = updateTempInput.toString();
      }
    }
  }

  await writeShedBehaviors({
    context: 'device detail',
    logMessage: 'Failed to save shed behavior',
    toastMessage: 'Failed to save shed behavior.',
    mutate: (currentBehaviors) => ({
      ...currentBehaviors,
      [deviceId]: nextBehavior,
    }),
    commit: (nextBehaviors) => {
      state.shedBehaviors = nextBehaviors;
    },
    rollback: () => {
      const activeDetailDeviceId = params.getCurrentDetailDeviceId();
      if (!activeDetailDeviceId) return;

      setDeviceDetailShedBehavior({
        deviceId: activeDetailDeviceId,
        getDeviceById: params.getDeviceById,
        isSteppedLoadControlModel: params.isSteppedLoadControlModel,
        updateSetStepOptionLabel: () => {},
      });
      updateShedFieldVisibility({
        currentDetailDeviceId: activeDetailDeviceId,
        getDeviceById: params.getDeviceById,
        isSteppedLoadControlModel: params.isSteppedLoadControlModel,
      });
    },
  });
};

export const initDeviceDetailShedHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
  isSteppedLoadControlModel: (device: TargetDeviceSnapshot | null) => boolean;
}) => {
  const autoSaveShedBehavior = async () => {
    const currentDetailDeviceId = params.getCurrentDetailDeviceId();
    updateShedFieldVisibility({
      currentDetailDeviceId,
      getDeviceById: params.getDeviceById,
      isSteppedLoadControlModel: params.isSteppedLoadControlModel,
    });
    await saveShedBehavior({
      currentDetailDeviceId,
      getCurrentDetailDeviceId: params.getCurrentDetailDeviceId,
      getDeviceById: params.getDeviceById,
      isSteppedLoadControlModel: params.isSteppedLoadControlModel,
    });
  };

  deviceDetailShedAction?.addEventListener('change', autoSaveShedBehavior);
  deviceDetailShedTemp?.addEventListener('change', autoSaveShedBehavior);
  deviceDetailShedStep?.addEventListener('change', autoSaveShedBehavior);
};

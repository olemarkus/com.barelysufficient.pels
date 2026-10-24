import { supportsPowerLimiting } from './temperaturePolicy.ts';
import {
  deviceDetailShedAction,
  deviceDetailShedCoolingTemp,
  deviceDetailShedCoolingTempRow,
  deviceDetailShedHint,
  deviceDetailShedSegmented,
  deviceDetailShedSegmentedLabel,
  deviceDetailShedStatement,
  deviceDetailShedStep,
  deviceDetailShedStepRow,
  deviceDetailShedTemp,
  deviceDetailShedTempRow,
} from '../dom.ts';
import { applyLimitWording, reportsThermostatMode } from './shedLimitWording.ts';
import {
  readShedLimitField,
  resolveCoolingShedTemperature,
  savedCoolingShedTemperature,
} from './shedTemperatureInputs.ts';
import { findLatestDevice, resolveManagedState, state } from '../state.ts';
import {
  isTemperatureDeviceWithoutOnOff,
  supportsPowerDevice,
  supportsTemperatureControlDevice,
  type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
import {
  HEATING_SHED_LIMIT_RANGE,
  isShedBehaviorsSetting,
  readShedBehaviors,
  resolveShedBehavior,
  type ConfiguredShedAction,
  type ConfiguredShedBehavior,
  type ShedLimitRange,
} from '../../../../shared-domain/src/settings/shedBehaviors.ts';
import { getPrimaryTargetCapability } from '../../../../shared-domain/src/targetCapabilities.ts';
import {
  OVERSHOOT_BEHAVIORS,
} from '../../../../shared-domain/src/settings/settingsKeys.ts';
import {
  computeDefaultSetpointShedTemperature,
  normalizeShedTemperature,
  resolveSetpointShedFloorC,
} from '../../../../shared-domain/src/utils/airtreatmentShedTemperature.ts';
import {
  createSerializedAsyncRunner,
  writeFreshSetting,
} from './settingsWrite.ts';
import {
  hasEvChargingControl,
  hasEvTargetPowerPreset,
  isSteppedLoadControlModel,
  resolveDeviceDetailKind,
} from '../deviceKind.ts';

type ShedAction = ConfiguredShedAction;

type ShedBehaviorWriteParams = {
  context: string;
  logMessage: string;
  toastMessage: string;
  mutate: (currentBehaviors: Record<string, ConfiguredShedBehavior>) => Record<string, ConfiguredShedBehavior>;
  commit?: (nextBehaviors: Record<string, ConfiguredShedBehavior>) => Promise<void> | void;
  rollback?: () => Promise<void> | void;
};

const runSerializedShedBehaviorWrite = createSerializedAsyncRunner();

export const writeShedBehaviors = async (params: ShedBehaviorWriteParams) => (
  runSerializedShedBehaviorWrite(() => writeFreshSetting<Record<string, ConfiguredShedBehavior>>({
    key: OVERSHOOT_BEHAVIORS,
    context: params.context,
    logMessage: params.logMessage,
    toastMessage: params.toastMessage,
    // Use the live shed-behavior snapshot as the fallback so a transient
    // null SDK read does not erase shed configurations for other devices. A
    // fresh read that is the map goes through the key's owner, so a write
    // never carries back an entry the runtime would read differently.
    fallbackValue: state.shedBehaviors,
    readFresh: (value) => (isShedBehaviorsSetting(value) ? readShedBehaviors(value) : null),
    mutate: params.mutate,
    commit: params.commit,
    rollback: params.rollback,
  }))
);

const updateShedActionOptions = (params: {
  canConfigure: boolean;
  forceTemperatureOnly: boolean;
  forceStepOnly: boolean;
  supportsTemperature: boolean;
  supportsStep: boolean;
}): void => {
  if (!deviceDetailShedAction) return;

  const turnOffOption = deviceDetailShedAction.querySelector<HTMLElement & { disabled: boolean }>(
    'md-select-option[value="turn_off"]',
  );
  const setTempOption = deviceDetailShedAction.querySelector<HTMLElement & { disabled: boolean }>(
    'md-select-option[value="set_temperature"]',
  );
  const setStepOption = deviceDetailShedAction.querySelector<HTMLElement & { disabled: boolean }>(
    'md-select-option[value="set_step"]',
  );

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
  const option = deviceDetailShedAction.querySelector<HTMLElement>(`md-select-option[value="${action}"]`);
  return Boolean(option && !option.hidden);
};

/**
 * The action the segmented control shows — which must be an action this device
 * actually offers here.
 *
 * A SAVED action whose option is hidden is answered with the behaviour the owner
 * will really get (`turn_off`, the runtime's own fallback). Rendering the hidden
 * value instead leaves the control with NEITHER visible option checked while the
 * device is turned off at limiting time — a state that is neither what is saved
 * nor what happens. Both arms need it: a stepped device can lose its ladder, and
 * a stepped device with on/off can carry a saved `set_temperature` from before
 * "Disable temperature control" was switched on.
 */
const resolveShedActionValue = (params: {
  canConfigure: boolean;
  forceTurnOffOnly: boolean;
  forceTemperatureOnly: boolean;
  forceStepOnly: boolean;
  supportsTemperature: boolean;
  supportsStep: boolean;
  configuredAction: ShedAction;
}): ShedAction => {
  if (!params.canConfigure) return 'turn_off';
  if (params.forceTurnOffOnly) return 'turn_off';
  if (params.forceTemperatureOnly) return 'set_temperature';
  if (params.forceStepOnly) return 'set_step';
  if (params.configuredAction === 'set_step') return params.supportsStep ? 'set_step' : 'turn_off';
  if (params.configuredAction === 'set_temperature') {
    return params.supportsTemperature ? 'set_temperature' : 'turn_off';
  }
  return params.configuredAction;
};

const resolveShedTemperatureValue = (params: {
  canConfigure: boolean;
  forceTemperatureOnly: boolean;
  saved: ConfiguredShedBehavior;
  fallbackTemperature: number;
}): string => {
  if (!params.canConfigure) return '';
  if (params.saved.action === 'set_temperature') return params.saved.temperature.toString();
  if (params.forceTemperatureOnly) return params.fallbackTemperature.toString();
  return '';
};

/**
 * The limit the planner applies to a device with no on/off when nothing is saved
 * (`resolveTemperaturePolicyShedBehavior`): from the active mode's target only,
 * never the mode being edited, and never from the live setpoint, which is the
 * limit itself while the device is limited.
 */
const getSetpointOnlyShedDefaultTemp = (device: SettingsUiDeviceDetailItem): number => {
  const activeModeTarget = state.modeTargets[state.activeMode]?.[device.id];
  return computeDefaultSetpointShedTemperature(
    typeof activeModeTarget === 'number' ? activeModeTarget : null,
    resolveSetpointShedFloorC(device.deviceClass || ''),
  );
};

const getShedDefaultTemp = (device: SettingsUiDeviceDetailItem | null): number => {
  if (!device) return 10;

  if (isTemperatureDeviceWithoutOnOff(device)) return getSetpointOnlyShedDefaultTemp(device);

  const modeTarget = state.modeTargets[state.activeMode]?.[device.id]
    ?? state.modeTargets[state.editingMode]?.[device.id];
  const normalizedModeTarget = typeof modeTarget === 'number' ? modeTarget : null;
  const currentTarget = typeof device.targets?.[0]?.value === 'number'
    ? device.targets[0].value
    : null;

  if (normalizedModeTarget !== null) return normalizedModeTarget;
  if (currentTarget !== null) return currentTarget;
  return 10;
};

/**
 * The heating limit field's range: the key's, capped at the device's own target
 * maximum, so a water heater's limit can go as high as its tank allows and no
 * device's limit goes above what its target accepts.
 */
const resolveHeatingShedLimitRange = (device: SettingsUiDeviceDetailItem | null): ShedLimitRange => {
  const deviceMaxC = getPrimaryTargetCapability(device?.targets)?.max;
  return typeof deviceMaxC === 'number' && Number.isFinite(deviceMaxC) && deviceMaxC < HEATING_SHED_LIMIT_RANGE.maxC
    ? { minC: HEATING_SHED_LIMIT_RANGE.minC, maxC: deviceMaxC }
    : HEATING_SHED_LIMIT_RANGE;
};

/** The heating limit to save: the field's value, raised to the device's floor when it has no on/off. */
const resolveHeatingShedTemperature = (
  device: SettingsUiDeviceDetailItem,
  saved: ConfiguredShedBehavior,
): number => {
  const savedC = saved.action === 'set_temperature' ? saved.temperature : getShedDefaultTemp(device);
  const fieldC = deviceDetailShedTemp
    ? readShedLimitField(deviceDetailShedTemp, resolveHeatingShedLimitRange(device), savedC)
    : savedC;
  const temperature = isTemperatureDeviceWithoutOnOff(device)
    ? Math.max(resolveSetpointShedFloorC(device.deviceClass || ''), normalizeShedTemperature(fieldC))
    : fieldC;
  // Show the field the value that is saved, whatever its text said.
  if (deviceDetailShedTemp) deviceDetailShedTemp.value = temperature.toString();
  return temperature;
};

/**
 * The setpoint entry to save. Every one carries both limits; only a device that
 * can say it is cooling has a cooling field to read, and a hidden field's value
 * is not the owner's choice.
 */
const resolveTemperatureShedBehavior = (device: SettingsUiDeviceDetailItem): ConfiguredShedBehavior => {
  if (!isTemperatureDeviceWithoutOnOff(device) && deviceDetailShedAction?.value !== 'set_temperature') {
    return { action: 'turn_off' };
  }
  const saved = resolveShedBehavior(state.shedBehaviors, device.id);
  const coolingTemperature = reportsThermostatMode(device) && deviceDetailShedCoolingTemp
    ? resolveCoolingShedTemperature(deviceDetailShedCoolingTemp, saved)
    : savedCoolingShedTemperature(saved);
  if (reportsThermostatMode(device) && deviceDetailShedCoolingTemp) {
    deviceDetailShedCoolingTemp.value = coolingTemperature.toString();
  }
  return {
    action: 'set_temperature',
    temperature: resolveHeatingShedTemperature(device, saved),
    coolingTemperature,
  };
};

const resolveVisibleShedAction = (device: SettingsUiDeviceDetailItem | null): ShedAction | null => {
  if (!deviceDetailShedAction || !device || !supportsPowerDevice(device)) return null;
  // Limiting switched off: the statement says PELS will not limit, so the
  // parameter rows (limited temperature / limited step) have nothing to set.
  if (isPowerLimitControlOff(device, device.id)) return null;

  if (isTemperatureDeviceWithoutOnOff(device) && isShedActionOptionVisible('set_temperature')) {
    return 'set_temperature';
  }
  if (
    deviceDetailShedAction.value === 'set_step'
    && isSteppedLoadControlModel(device)
    && isShedActionOptionVisible('set_step')
  ) {
    return 'set_step';
  }
  if (
    deviceDetailShedAction.value === 'set_temperature'
    && supportsTemperatureControlDevice(device)
    && isShedActionOptionVisible('set_temperature')
  ) {
    return 'set_temperature';
  }
  return null;
};

const resolveShedControlCapabilities = (params: {
  device: SettingsUiDeviceDetailItem | null;
}) => {
  const { device } = params;
  // Limiting by setpoint is denied only when temperature control is off ("Keep
  // the new temperature"); "Save as current mode target" keeps the limit.
  const supportsTemperature = supportsTemperatureControlDevice(device);
  const supportsPower = supportsPowerDevice(device);
  const forceTurnOffOnly = hasEvTargetPowerPreset(device);
  // The step arm is its own axis: "Disable temperature control" denies the
  // setpoint, never the ladder, so a flagged stepped device still offers
  // "step down" alongside "turn off".
  const supportsStep = isSteppedLoadControlModel(device) && !forceTurnOffOnly;
  const canConfigure = supportsPower && (forceTurnOffOnly || supportsTemperature || supportsStep);
  const forceTemperatureOnly = canConfigure && !supportsStep && isTemperatureDeviceWithoutOnOff(device);
  const hasBinaryControl = device?.capabilities?.includes('onoff') === true
    || hasEvChargingControl(device);
  return {
    supportsTemperature,
    supportsStep,
    canConfigure,
    forceTurnOffOnly,
    forceTemperatureOnly,
    forceStepOnly: supportsStep && !hasBinaryControl,
  };
};

// A device whose limiting control has nothing to choose gets a statement of
// what PELS does instead of a one-button radiogroup dressed as a choice.
// Power-limit control switched off is stated outright rather than describing
// hypothetical behavior.
const isPowerLimitControlOff = (
  device: SettingsUiDeviceDetailItem | null,
  deviceId: string,
): boolean => (
  supportsPowerDevice(device)
  && resolveManagedState(deviceId)
  && state.controllableMap[deviceId] !== true
);

const resolveUnavailablePowerLimitingStatement = (device: SettingsUiDeviceDetailItem | null, noun: string): string => (
  supportsPowerDevice(device)
    ? 'PELS cannot limit this device without changing its temperature.'
    : `PELS does not limit this ${noun}.`
);

// A device with only the setpoint to limit on. A reversible unit's sentence
// names both directions.
const temperatureOnlyStatement = (device: SettingsUiDeviceDetailItem): string => (
  reportsThermostatMode(device)
    ? 'When limiting this device, PELS lowers its temperature while it is heating '
      + 'and raises it while it is cooling, instead of turning it off.'
    : 'When limiting this device, PELS lowers its temperature instead of turning it off.'
);

const resolveShedStatement = (params: {
  device: SettingsUiDeviceDetailItem;
  deviceId: string;
  shedControls: ReturnType<typeof resolveShedControlCapabilities>;
}): string | null => {
  const { device, deviceId, shedControls } = params;
  const noun = resolveDeviceDetailKind(device) === 'ev_charger' ? 'charger' : 'device';

  if (!supportsPowerLimiting(device)) {
    return resolveUnavailablePowerLimitingStatement(device, noun);
  }
  if (isPowerLimitControlOff(device, deviceId)) {
    return `Power-limit control is off — PELS will not limit this ${noun}.`;
  }

  const turnOffVisible = !shedControls.forceTemperatureOnly && !shedControls.forceStepOnly;
  const visibleOptionCount = (turnOffVisible ? 1 : 0)
    + (shedControls.supportsTemperature ? 1 : 0)
    + (shedControls.supportsStep ? 1 : 0);
  if (shedControls.canConfigure && visibleOptionCount > 1) return null;

  if (noun === 'charger') {
    // A charger on an amp preset is limited by LEVEL first. Since 2026-08-17 the
    // planner parks it at the highest charging level that fits and reaches a
    // pause only when nothing lower would do (`lib/plan/planSteppedShedResolution.ts`
    // — the configured behaviour is the worst case, not the action). A bare
    // pause sentence would contradict the Overview, which reads
    // `Limited to 16 A` for exactly this charger.
    if (shedControls.forceTurnOffOnly) {
      return 'When limiting this charger, PELS lowers the charging level, '
        + 'and pauses charging only if lowering is not enough. It resumes when power allows.';
    }
    // No level ladder, so pausing is the whole of it — and pausing is what a
    // binary "turn off" on the charging capability actuates
    // (lib/executor/shedReleaseActuation.ts), so "turns it off" would misstate
    // what the owner observes.
    return 'When limiting this charger, PELS pauses charging and resumes it when power allows.';
  }
  if (shedControls.forceTemperatureOnly) return temperatureOnlyStatement(device);
  if (shedControls.forceStepOnly) {
    return 'When limiting this device, PELS steps it down and back up as power allows.';
  }
  if (state.temperatureControlDisabledMap[deviceId] === true) {
    return 'Temperature control is off for this device. '
      + 'When limiting it, PELS turns it off and turns it back on when power allows.';
  }
  return 'When limiting this device, PELS turns it off and turns it back on when power allows.';
};

const renderShedStatement = (statement: string | null): void => {
  if (deviceDetailShedStatement) {
    deviceDetailShedStatement.textContent = statement ?? '';
    deviceDetailShedStatement.hidden = statement === null;
  }
  if (deviceDetailShedSegmented) deviceDetailShedSegmented.hidden = statement !== null;
  if (deviceDetailShedSegmentedLabel) deviceDetailShedSegmentedLabel.hidden = statement !== null;
  if (deviceDetailShedHint) deviceDetailShedHint.hidden = statement !== null;
};

export const setDeviceDetailShedBehavior = (
  deviceId: string,
  device: SettingsUiDeviceDetailItem | null,
  updateSetStepOptionLabel: (device: SettingsUiDeviceDetailItem | null) => void,
) => {
  updateSetStepOptionLabel(device);

  const shedControls = resolveShedControlCapabilities({
    device,
  });
  const saved = resolveShedBehavior(state.shedBehaviors, deviceId);

  // A device that is no longer there is one PELS does not limit.
  renderShedStatement(device === null ? 'PELS does not limit this device.' : resolveShedStatement({
    device,
    deviceId,
    shedControls,
  }));

  updateShedActionOptions({
    canConfigure: shedControls.canConfigure,
    forceTemperatureOnly: shedControls.forceTemperatureOnly,
    forceStepOnly: shedControls.forceStepOnly,
    supportsTemperature: shedControls.supportsTemperature,
    supportsStep: shedControls.supportsStep,
  });

  if (deviceDetailShedAction) {
    deviceDetailShedAction.value = resolveShedActionValue({
      canConfigure: shedControls.canConfigure,
      forceTurnOffOnly: shedControls.forceTurnOffOnly,
      forceTemperatureOnly: shedControls.forceTemperatureOnly,
      forceStepOnly: shedControls.forceStepOnly,
      supportsTemperature: shedControls.supportsTemperature,
      supportsStep: shedControls.supportsStep,
      configuredAction: saved.action,
    });
    deviceDetailShedAction.dispatchEvent(new Event('pels:segmented-refresh'));
  }

  if (deviceDetailShedStep) {
    deviceDetailShedStep.innerHTML = '';
    deviceDetailShedStep.disabled = true;
  }

  if (deviceDetailShedTemp) {
    deviceDetailShedTemp.value = resolveShedTemperatureValue({
      canConfigure: shedControls.canConfigure,
      forceTemperatureOnly: shedControls.forceTemperatureOnly,
      saved,
      fallbackTemperature: getShedDefaultTemp(device),
    });
    deviceDetailShedTemp.disabled = !shedControls.canConfigure;
    deviceDetailShedTemp.max = resolveHeatingShedLimitRange(device).maxC.toString();
  }
  if (deviceDetailShedCoolingTemp) {
    deviceDetailShedCoolingTemp.value = shedControls.canConfigure
      ? savedCoolingShedTemperature(saved).toString()
      : '';
    deviceDetailShedCoolingTemp.disabled = !shedControls.canConfigure;
  }
};

export const updateShedFieldVisibility = (device: SettingsUiDeviceDetailItem | null) => {
  if (!deviceDetailShedAction || !deviceDetailShedTempRow || !deviceDetailShedStepRow) return;

  const selectedAction = resolveVisibleShedAction(device);
  const showsCoolingLimit = selectedAction === 'set_temperature' && device !== null && reportsThermostatMode(device);
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
        const fallback = getShedDefaultTemp(device);
        deviceDetailShedTemp.value = fallback.toString();
      }
    }
  }
  // The cooling limit only makes sense on a device that can say it is cooling.
  if (deviceDetailShedCoolingTempRow) {
    deviceDetailShedCoolingTempRow.hidden = !showsCoolingLimit;
  }
  if (deviceDetailShedCoolingTemp) {
    deviceDetailShedCoolingTemp.disabled = selectedAction !== 'set_temperature';
  }
  if (device !== null) applyLimitWording(device);

  deviceDetailShedStepRow.hidden = true;
};

const saveShedBehavior = async (
  device: SettingsUiDeviceDetailItem | null,
  getCurrentDetailDeviceId: () => string | null,
) => {
  // A device that is no longer there has nothing to save.
  if (device === null) return;
  const deviceId = device.id;
  let nextBehavior: ConfiguredShedBehavior = { action: 'turn_off' };

  if (supportsPowerDevice(device)) {
    if (
      isSteppedLoadControlModel(device)
      && !hasEvTargetPowerPreset(device)
      && deviceDetailShedAction?.value === 'set_step'
    ) {
      nextBehavior = { action: 'set_step' };
    } else if (supportsTemperatureControlDevice(device)) {
      nextBehavior = resolveTemperatureShedBehavior(device);
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
      const activeDetailDeviceId = getCurrentDetailDeviceId();
      if (!activeDetailDeviceId) return;

      const activeDevice = findLatestDevice(activeDetailDeviceId);
      setDeviceDetailShedBehavior(activeDetailDeviceId, activeDevice, () => {});
      updateShedFieldVisibility(activeDevice);
    },
  });
};

export const initDeviceDetailShedHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
}) => {
  const autoSaveShedBehavior = async () => {
    const currentDetailDeviceId = params.getCurrentDetailDeviceId();
    const device = currentDetailDeviceId ? findLatestDevice(currentDetailDeviceId) : null;
    updateShedFieldVisibility(device);
    await saveShedBehavior(device, params.getCurrentDetailDeviceId);
  };

  deviceDetailShedAction?.addEventListener('change', autoSaveShedBehavior);
  deviceDetailShedTemp?.addEventListener('change', autoSaveShedBehavior);
  deviceDetailShedCoolingTemp?.addEventListener('change', autoSaveShedBehavior);
  deviceDetailShedStep?.addEventListener('change', autoSaveShedBehavior);
};

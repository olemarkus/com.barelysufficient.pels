import type {
  DeviceTargetPowerConfigs,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../../../contracts/src/types.ts';
import { DEVICE_TARGET_POWER_CONFIGS } from '../../../../contracts/src/settingsKeys.ts';
import { createEvTargetPowerConfig } from '../../../../shared-domain/src/evTargetPowerConfig.ts';
import {
  deviceDetailTargetPowerClear,
  deviceDetailTargetPowerConfig,
  deviceDetailTargetPowerExcludeMax,
  deviceDetailTargetPowerExcludeMin,
  deviceDetailTargetPowerFields,
  deviceDetailTargetPowerMax,
  deviceDetailTargetPowerMin,
  deviceDetailTargetPowerSave,
  deviceDetailTargetPowerStep,
} from '../dom.ts';
import { normalizeDeviceTargetPowerConfigs } from '../deviceControlProfiles.ts';
import { state } from '../state.ts';
import { showToastError } from '../toast.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

const runSerializedTargetPowerWrite = createSerializedAsyncRunner();
const TARGET_POWER_MAX_GENERATED_STEPS = 128;

export { createEvTargetPowerConfig };

export const createContinuousTargetPowerConfig = (device: TargetDeviceSnapshot): TargetPowerSteppedLoadConfig => {
  const existing = state.deviceTargetPowerConfigs[device.id] ?? device.targetPowerConfig;
  if (existing && !existing.preset) return { ...existing, enabled: true };
  const max = Math.max(
    1000,
    Math.round((device.expectedPowerKw ?? device.measuredPowerKw ?? device.powerKw ?? 1.5) * 1000),
  );
  const step = 100;
  return {
    enabled: true,
    min: 0,
    max,
    step,
  };
};

export const renderTargetPowerConfig = (device: TargetDeviceSnapshot) => {
  if (!deviceDetailTargetPowerConfig) return;
  const config = state.deviceTargetPowerConfigs[device.id] ?? device.targetPowerConfig;
  const showRange = Boolean(config && !config.preset);
  deviceDetailTargetPowerConfig.hidden = !showRange;
  if (deviceDetailTargetPowerFields) deviceDetailTargetPowerFields.hidden = !showRange;
  if (!showRange) return;

  setNumberInput(deviceDetailTargetPowerMin, config.min);
  setNumberInput(deviceDetailTargetPowerMax, config.max);
  setNumberInput(deviceDetailTargetPowerStep, config.step);
  setNumberInput(deviceDetailTargetPowerExcludeMin, config.excludeMin);
  setNumberInput(deviceDetailTargetPowerExcludeMax, config.excludeMax);
};

export const initTargetPowerConfigHandlers = (params: {
  getCurrentDetailDeviceId: () => string | null;
  refreshOpenDeviceDetail: () => void;
}) => {
  deviceDetailTargetPowerSave?.addEventListener('click', async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;
    try {
      const config = collectTargetPowerConfig();
      await persistTargetPowerConfig({
        deviceId,
        config,
        refreshOpenDeviceDetail: params.refreshOpenDeviceDetail,
      });
    } catch (error) {
      await showToastError(error, 'Failed to save target power model.');
    }
  });

  deviceDetailTargetPowerClear?.addEventListener('click', async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId) return;
    await persistTargetPowerConfig({
      deviceId,
      config: null,
      refreshOpenDeviceDetail: params.refreshOpenDeviceDetail,
    });
  });
};

export async function persistTargetPowerConfig(params: {
  deviceId: string;
  config: TargetPowerSteppedLoadConfig | null;
  refreshOpenDeviceDetail: () => void;
}) {
  await runSerializedTargetPowerWrite(async () => {
    await writeFreshSetting<DeviceTargetPowerConfigs>({
      key: DEVICE_TARGET_POWER_CONFIGS,
      context: 'device detail',
      logMessage: 'Failed to save target power model',
      toastMessage: 'Failed to save target power model.',
      fallbackValue: {},
      readFresh: normalizeDeviceTargetPowerConfigs,
      mutate: (currentMap) => {
        const nextMap = { ...currentMap };
        if (params.config) nextMap[params.deviceId] = params.config;
        else delete nextMap[params.deviceId];
        return nextMap;
      },
      commit: (nextMap) => {
        state.deviceTargetPowerConfigs = nextMap;
        params.refreshOpenDeviceDetail();
      },
      rollback: params.refreshOpenDeviceDetail,
    });
  });
}

function collectTargetPowerConfig(): TargetPowerSteppedLoadConfig {
  const config: TargetPowerSteppedLoadConfig = {
    enabled: true,
    ...numberProp('min', readNumberInput(deviceDetailTargetPowerMin)),
    ...numberProp('max', readNumberInput(deviceDetailTargetPowerMax)),
    ...numberProp('step', readNumberInput(deviceDetailTargetPowerStep)),
    ...numberProp('excludeMin', readNumberInput(deviceDetailTargetPowerExcludeMin)),
    ...numberProp('excludeMax', readNumberInput(deviceDetailTargetPowerExcludeMax)),
  };
  validateTargetPowerConfig(config);
  return config;
}

function validateTargetPowerConfig(config: TargetPowerSteppedLoadConfig): void {
  const max = config.max;
  const step = config.step;
  if (max === undefined || step === undefined) {
    throw new Error('Max W and step W are required.');
  }
  if (max <= 0 || step <= 0) {
    throw new Error('Max W and step W must be positive.');
  }
  const excludedMax = config.excludeMax && config.excludeMax > 0 ? config.excludeMax : undefined;
  const configuredMin = config.min && config.min > 0 ? config.min : undefined;
  const min = excludedMax ?? configuredMin ?? step;
  if (min > max) {
    throw new Error('Min W cannot be greater than max W.');
  }
  const stepCount = Math.floor((max - min) / step) + 1;
  if (stepCount < 1 || stepCount > TARGET_POWER_MAX_GENERATED_STEPS) {
    throw new Error(`Target power range must produce between 1 and ${TARGET_POWER_MAX_GENERATED_STEPS} steps.`);
  }
}

type ValueHost = HTMLElement & { value: string };

function setNumberInput(input: ValueHost | null, value: number | undefined) {
  const element = input;
  if (!element) return;
  element.value = value === undefined ? '' : String(value);
}

function readNumberInput(input: ValueHost | null): number | undefined {
  const value = input?.value.trim();
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberProp<T extends 'min' | 'max' | 'step' | 'excludeMin' | 'excludeMax'>(
  key: T,
  value: number | undefined,
): Partial<Record<T, number>> {
  return value !== undefined ? { [key]: value } as Partial<Record<T, number>> : {};
}

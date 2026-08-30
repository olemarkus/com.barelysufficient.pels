import type {
  DeviceTargetPowerConfigs,
  TargetPowerSteppedLoadConfig,
} from '../../../../contracts/src/types.ts';
import { type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { DEVICE_TARGET_POWER_CONFIGS } from '../../../../contracts/src/settingsKeys.ts';
import { createEvTargetPowerConfig } from '../../../../shared-domain/src/evTargetPowerConfig.ts';
import {
  resolveTargetPowerLadderIssue,
  TARGET_POWER_MAX_GENERATED_STEPS,
  type TargetPowerLadderIssue,
} from '../../../../shared-domain/src/targetPowerLadder.ts';
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

export { createEvTargetPowerConfig };

export const createContinuousTargetPowerConfig = (
  device: SettingsUiDeviceDetailItem,
): TargetPowerSteppedLoadConfig => {
  const existing = state.deviceTargetPowerConfigs[device.id] ?? device.targetPowerConfig;
  // Carrying a previous range forward is a courtesy; carrying forward one that
  // produces no steps would hand the runtime a config it has to throw away, so
  // that case falls through to a freshly estimated range instead.
  if (existing && !existing.preset && resolveTargetPowerLadderIssue(existing) === undefined) {
    return { ...existing, enabled: true };
  }
  // Seeds an editable draft, so one producer-resolved figure is enough — the
  // `?? measuredPowerKw ?? powerKw ?? 1.5` tail existed only because
  // `expectedPowerKw` used to be absent for a device nobody had described.
  const max = Math.max(1000, Math.round(device.expectedPowerKw * 1000));
  return {
    enabled: true,
    min: 0,
    max,
    step: resolveSeedStepW(max),
  };
};

/**
 * 100 W rungs, widened just enough to stay inside the shared step ceiling.
 *
 * A flat 100 W seed overflows on anything above ~12.8 kW — a three-phase
 * charger seeded 220 rungs — and the screen would then hand the owner a draft
 * its own Save rejects. Widening in 100 W multiples keeps the familiar
 * granularity for ordinary loads and only coarsens where it has to.
 */
const resolveSeedStepW = (maxW: number): number => Math.max(
  100,
  Math.ceil(maxW / TARGET_POWER_MAX_GENERATED_STEPS / 100) * 100,
);

export const renderTargetPowerConfig = (device: SettingsUiDeviceDetailItem) => {
  if (!deviceDetailTargetPowerConfig) return;
  const config = state.deviceTargetPowerConfigs[device.id] ?? device.targetPowerConfig;
  // Same axis rule as the step editor: a power range generates rungs, and
  // "Disable temperature control" denies setpoint writes, not rungs.
  const showRange = config !== undefined && config !== null && !config.preset;
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
      // Use the live target-power configs snapshot as the fallback so a
      // transient null or non-object SDK read does not erase entries for
      // other devices.
      fallbackValue: state.deviceTargetPowerConfigs,
      // Only normalize when the fresh SDK value is a real object.
      // Anything else returns null so `writeFreshSetting` falls back to
      // the snapshot instead of normalising garbage into `{}`.
      readFresh: (value) => (
        value && typeof value === 'object' && !Array.isArray(value)
          ? normalizeDeviceTargetPowerConfigs(value)
          : null
      ),
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

// Delegates to the shared assessment the runtime producer uses, so a range this
// screen accepts is exactly a range PELS can build a ladder from. The messages
// stay here because only this screen has a user to explain the rejection to.
const TARGET_POWER_LADDER_ISSUE_MESSAGES: Record<TargetPowerLadderIssue, string> = {
  missing_max: 'Max W and step W are required.',
  missing_step: 'Max W and step W are required.',
  negative_max: 'Max W and step W must be positive.',
  negative_step: 'Max W and step W must be positive.',
  min_excludes_zero: 'Min W must be 0 — use the excluded range to set the lowest power the device runs at.',
  step_exceeds_range: 'This range produces no steps. Lower the step W or raise the max W.',
  too_many_generated_steps:
    `This range produces more than ${TARGET_POWER_MAX_GENERATED_STEPS} steps. Raise the step W.`,
};

function validateTargetPowerConfig(config: TargetPowerSteppedLoadConfig): void {
  const issue = resolveTargetPowerLadderIssue(config);
  if (issue === undefined) return;
  throw new Error(TARGET_POWER_LADDER_ISSUE_MESSAGES[issue]);
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

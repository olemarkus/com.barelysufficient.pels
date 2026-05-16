import type { HomeyDeviceLike, Logger } from '../utils/types';
import { shouldEmitOnChange } from '../logging/logDedupe';
import type { DeviceCapabilityMap } from './deviceManagerControl';
import {
  assessTargetPowerCapabilityOptions,
  TARGET_POWER_CAPABILITY_ID,
} from './nativeSteppedLoadWiring';

const targetPowerContractLogState = new Map<string, { signature: string; emittedAt: number }>();
const TARGET_POWER_CONTRACT_LOG_REPEAT_AFTER_MS = 60 * 60 * 1000;

export function resetTargetPowerContractLogStateForTests(): void {
  targetPowerContractLogState.clear();
}

/**
 * Emits a deduplicated structured warning when a device exposes target_power
 * capability options that violate Homey's contract (e.g., a range that
 * excludes 0). The warning is suppressed when the capability options are
 * empty — those are common during cold reads and would otherwise produce
 * noise during normal operation.
 */
export function warnIfTargetPowerCapabilityViolatesContract(params: {
  logger: Logger;
  device: HomeyDeviceLike;
  capabilities: readonly string[];
  capabilityObj: DeviceCapabilityMap;
}): void {
  const { logger, device, capabilities, capabilityObj } = params;
  if (!capabilities.includes(TARGET_POWER_CAPABILITY_ID)) return;
  const capability = capabilityObj[TARGET_POWER_CAPABILITY_ID];
  if (!capability || !isCapabilityPopulated(capability)) return;
  const assessment = assessTargetPowerCapabilityOptions(capability);
  if (assessment.valid) return;
  const optionSnapshot = buildOptionSnapshot(capability);
  if (!shouldEmitContractWarning({
    deviceId: device.id,
    issue: assessment.issue,
    optionSnapshot,
  })) return;
  logger.structuredLog?.warn({
    event: 'target_power_contract_violation',
    deviceId: device.id,
    deviceName: device.name,
    driverId: device.driverId ?? null,
    ownerUri: device.ownerUri ?? null,
    issue: assessment.issue,
    ...optionSnapshot,
  });
}

function isCapabilityPopulated(
  capability: DeviceCapabilityMap[string],
): boolean {
  return capability.max !== undefined
    || capability.step !== undefined
    || capability.min !== undefined;
}

type TargetPowerOptionSnapshot = {
  min: number | null;
  max: number | null;
  step: number | null;
  excludeMin: number | null;
  excludeMax: number | null;
};

function buildOptionSnapshot(capability: DeviceCapabilityMap[string]): TargetPowerOptionSnapshot {
  return {
    min: capability.min ?? null,
    max: capability.max ?? null,
    step: capability.step ?? null,
    excludeMin: capability.excludeMin ?? null,
    excludeMax: capability.excludeMax ?? null,
  };
}

function shouldEmitContractWarning(params: {
  deviceId: string;
  issue: string;
  optionSnapshot: TargetPowerOptionSnapshot;
}): boolean {
  return shouldEmitOnChange({
    state: targetPowerContractLogState,
    key: `${params.deviceId}:target_power_contract`,
    signature: JSON.stringify({ issue: params.issue, ...params.optionSnapshot }),
    now: Date.now(),
    repeatAfterMs: TARGET_POWER_CONTRACT_LOG_REPEAT_AFTER_MS,
  });
}

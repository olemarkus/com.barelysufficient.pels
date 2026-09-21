import type {
  PriceOptimizationSetup,
  PriceOptimizationSetupRead,
} from '../../../contracts/src/priceOptimizationSettings.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

type StringListRead =
  | { state: 'resolved'; value: readonly string[] }
  | { state: 'unavailable' };

const readStringList = (value: unknown): StringListRead => (
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? { state: 'resolved', value: [...new Set(value)] }
    : { state: 'unavailable' }
);

const readSetup = (value: unknown): PriceOptimizationSetupRead => {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return { state: 'unavailable' };
  const configuredDeviceIds = readStringList(value.configuredDeviceIds);
  const solarSurplusDeviceIds = readStringList(value.solarSurplusDeviceIds);
  if (configuredDeviceIds.state === 'unavailable' || solarSurplusDeviceIds.state === 'unavailable') {
    return { state: 'unavailable' };
  }
  const setup: PriceOptimizationSetup = {
    enabled: value.enabled,
    configuredDeviceIds: configuredDeviceIds.value,
    solarSurplusDeviceIds: solarSurplusDeviceIds.value,
  };
  return { state: 'resolved', setup };
};

/** Classify the Homey API bridge once; inward consumers receive only trusted fields. */
export const classifyPriceOptimizationSetupRead = (value: unknown): PriceOptimizationSetupRead => {
  if (!isRecord(value) || value.state !== 'resolved') return { state: 'unavailable' };
  return readSetup(value.setup);
};

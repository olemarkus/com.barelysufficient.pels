import { getLogger } from '../lib/logging/logger';
import type { DeviceLimitEvent } from '../lib/ports/deviceLimitEvents';
import type { FlowManagerLike } from '../lib/utils/types';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import { readFlowDeviceArg, readFlowStringArg } from './flowArgParsers';
import type { FlowCardDeps } from './registerFlowCards';

const CARD_IDS = { limited: 'pels_device_limited', resumed: 'pels_device_resumed' } as const;
const ANY_DEVICE = { id: 'pels:any-device', name: 'Any device' };

export function registerDeviceLimitCards(deps: Pick<FlowCardDeps, 'homey' | 'getDeviceDescriptors'>): void {
  const autocomplete = async (query: string) => {
    const devices = await deps.getDeviceDescriptors();
    const loads = devices.filter((device) => device.managed && !device.isBatteryOrSolar);
    const options = buildDeviceAutocompleteOptions(loads, query);
    return ANY_DEVICE.name.toLowerCase().includes(query.trim().toLowerCase()) ? [ANY_DEVICE, ...options] : options;
  };
  for (const id of Object.values(CARD_IDS)) {
    const card = deps.homey.flow.getTriggerCard(id);
    card.registerArgumentAutocompleteListener('device', autocomplete);
    card.registerRunListener((args, state) => {
      const device = readFlowDeviceArg(args);
      const deviceId = readFlowStringArg(state, 'deviceId');
      return deviceId !== '' && (device === ANY_DEVICE.id || device === deviceId);
    });
  }
}

export function createDeviceLimitFlowEmitter(
  flow: Pick<FlowManagerLike, 'getTriggerCard'>,
  readHourUsageKWh: (atMs: number) => number,
): (event: DeviceLimitEvent) => void {
  const logger = getLogger('flow/device-limit');
  const publish = async (event: DeviceLimitEvent): Promise<void> => {
    const card = flow?.getTriggerCard(CARD_IDS[event.kind]);
    await card?.trigger?.({
      device_name: event.deviceName,
      hourly_usage_kwh: readHourUsageKWh(event.atMs),
      ...(event.kind === 'limited' ? {
        reason: event.reason,
        action: event.action,
        // Homey gets a numeric tag on every run. The companion tag distinguishes
        // an unavailable measurement from genuinely zero available power.
        available_power_known: event.availablePowerKw !== undefined,
        available_power_kw: event.availablePowerKw ?? 0,
      } : {
        limited_minutes: Math.max(0, event.atMs - event.limitedAtMs) / 60_000,
      }),
    }, { deviceId: event.deviceId });
  };
  return (event) => {
    void publish(event).catch((err: unknown) => logger.warn({
      event: 'device_limit_flow_trigger_failed',
      deviceId: event.deviceId,
      transition: event.kind,
      err,
    }));
  };
}

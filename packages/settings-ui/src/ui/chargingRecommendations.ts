import type { ChargingAccessStatus, ChargingCurrentRead } from '../../../contracts/src/chargingControl.ts';
import type { SetupRecommendation } from './recommendationsModel.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';

export function chargingRecommendations(
  devices: readonly ChargingCurrentRead[],
  access: ChargingAccessStatus,
): SetupRecommendation[] {
  return devices.flatMap((device): SetupRecommendation[] => {
    if (device.sharedInstallation) return [];
    let kind: string;
    let title: string;
    let body: string;
    const name = formatDisplayDeviceName(device.name);
    if (device.flowCheck === 'conflict'
      && (device.setup.method === 'built_in' || access.configured || device.capabilityWritable)) {
      kind = 'charging-remove-flow';
      title = `Remove duplicate current control for ${name}`;
      body = device.setup.method === 'built_in'
        ? 'Remove the current-setting action from your Flow so it does not compete with built-in control. '
          + 'Then check again.'
        : 'A current-setting Flow is configured alongside built-in access. Remove that action, check again, '
          + 'then explicitly choose built-in control. Adding a key does not switch your existing Flow.';
    } else if (device.scope === 'vehicle' && device.setup.confirmation !== 'vehicle') {
      kind = 'charging-owner';
      title = `Choose how PELS controls ${name}`;
      body = 'Control either the car or its physical charger. '
        + 'Confirm your choice on the device page before enabling car control.';
    } else if (device.setup.method === 'built_in' && (device.capabilityWritable || access.state === 'ready')) return [];
    else {
      kind = 'charging-setup';
      title = `Set up charging-current control for ${name}`;
      body = device.capabilityWritable
        ? 'This device exposes writable current control. '
          + 'Review the installation and choose built-in control on its device page.'
        : 'Use a Homey API key with Flow permission for built-in current control, or keep a current-setting Flow. '
          + 'One key works for all supported cars and chargers on this Homey.';
    }
    return [{ id: `${kind}:${encodeURIComponent(device.deviceId)}`, version: 1, category: 'recommendation',
      title, body, actionLabel: 'Review device', target: { kind: 'device', deviceId: device.deviceId } }];
  });
}

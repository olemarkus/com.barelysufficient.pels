import type { DeviceDescriptorRead } from '../packages/contracts/src/types';
import type { FlowCardDeps } from './registerFlowCards';
import { readFlowNumberArg, readFlowStringArg } from './flowArgParsers';

const canPauseHeating = (device: DeviceDescriptorRead): boolean => (
  device.deviceType === 'temperature'
  && device.managed
  && device.controllable === true
  && device.binaryControllable
  && device.powerCapable === true
  && !device.steppedLoadProfile
  && !device.isBatteryOrSolar
);

async function listScopes(deps: FlowCardDeps): Promise<Array<{ id: string; name: string }>> {
  const devices = (await deps.getDeviceDescriptors()).filter(canPauseHeating);
  const zones = new Map<string, string>();
  for (const { zoneId } of devices) {
    if (zoneId === undefined || zones.has(zoneId)) continue;
    const zoneName = deps.getHeatingPauseZoneName(zoneId);
    if (zoneName !== undefined) zones.set(zoneId, zoneName);
  }
  return [
    ...devices.map(({ id, name }) => ({ id: `device:${id}`, name })),
    ...Array.from(zones, ([id, name]) => ({ id: `zone:${id}`, name: `Zone: ${name}` })),
  ];
}

export function registerHeatingPauseCards(deps: FlowCardDeps): void {
  const pause = deps.homey.flow.getActionCard('pause_heating_for_open_window');
  const resume = deps.homey.flow.getActionCard('resume_heating_after_open_window');
  const autocomplete = async (query: string) => {
    const search = query.trim().toLowerCase();
    return (await listScopes(deps)).filter(({ name }) => name.toLowerCase().includes(search));
  };
  pause.registerArgumentAutocompleteListener('scope', autocomplete);
  resume.registerArgumentAutocompleteListener('scope', autocomplete);
  pause.registerRunListener(async (args: unknown) => {
    const scope = readFlowStringArg(args, 'scope');
    if (!(await listScopes(deps)).some(({ id }) => id === scope)) {
      throw new Error('Choose a zone or a managed heater with power limiting and on/off control.');
    }
    const minutes = readFlowNumberArg(args, 'minutes');
    deps.heatingPauses.pause(scope, minutes ?? NaN, deps.getNow().getTime());
    return true;
  });
  resume.registerRunListener(async (args: unknown) => {
    const scope = readFlowStringArg(args, 'scope');
    if (!/^(device|zone):.+$/.test(scope)) throw new Error('Choose a device or zone.');
    deps.heatingPauses.resume(scope);
    return true;
  });
}

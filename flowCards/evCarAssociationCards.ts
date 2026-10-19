import type { FlowCardDeps } from './registerFlowCards';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import { readFlowDeviceArg, readFlowNumberArg } from './flowArgParsers';

/** Only match the crossing that first reaches this Flow's chosen timeout. */
function matchesWaitingCrossing(args: unknown, state: unknown): boolean {
  const chargerId = readFlowDeviceArg(args, 'charger');
  const minutes = readFlowNumberArg(args, 'minutes');
  if (!chargerId || minutes === null || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) return false;
  if (!state || typeof state !== 'object') return false;
  const crossing = state as Record<string, unknown>;
  const { previousMinutes, elapsedMinutes } = crossing;
  return crossing.chargerId === chargerId
    && typeof previousMinutes === 'number' && Number.isFinite(previousMinutes) && previousMinutes >= 0
    && typeof elapsedMinutes === 'number' && Number.isFinite(elapsedMinutes)
    && previousMinutes < minutes && minutes <= elapsedMinutes;
}

export function registerEvCarAssociationCards(deps: FlowCardDeps): void {
  const chargers = async (query: string) => {
    const descriptors = await deps.getDeviceDescriptors();
    return buildDeviceAutocompleteOptions(descriptors.filter((device) => (
      device.isEvCharger && deps.getCarAssociationCarIds(device.id).length > 0
    )), query);
  };
  const trigger = deps.homey.flow.getTriggerCard('ev_car_association_waiting');
  trigger.registerRunListener(async (args: unknown, state?: unknown) => matchesWaitingCrossing(args, state));
  trigger.registerArgumentAutocompleteListener('charger', chargers);

  const condition = deps.homey.flow.getConditionCard('ev_car_association_waiting');
  condition.registerRunListener(async (args: unknown) => {
    const chargerId = readFlowDeviceArg(args, 'charger');
    return Boolean(chargerId) && deps.isWaitingForCarAssociation(chargerId);
  });
  condition.registerArgumentAutocompleteListener('charger', chargers);

  const action = deps.homey.flow.getActionCard('confirm_ev_car_association');
  action.registerRunListener(async (args: unknown) => {
    const chargerId = readFlowDeviceArg(args, 'charger');
    const carId = readFlowDeviceArg(args, 'car');
    if (!chargerId || !carId) throw new Error('Select a charger and a car.');
    deps.confirmCarAssociation(chargerId, carId);
    return true;
  });
  action.registerArgumentAutocompleteListener('charger', chargers);
  action.registerArgumentAutocompleteListener('car', async (query: string, args: unknown) => {
    const chargerId = readFlowDeviceArg(args, 'charger');
    if (!chargerId) return [];
    const selected = deps.getCarAssociationCarIds(chargerId);
    const candidates = deps.readCarAssociationCandidates();
    if (candidates.state === 'unavailable') return [];
    return buildDeviceAutocompleteOptions(candidates.cars.filter((car) => selected.includes(car.id)), query);
  });
}

import type { SettingsUiCarAssociationConfirmation } from '../../packages/contracts/src/settingsUi/carLink';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import { ApiRequestError } from '../utils/apiRequestError';
import type { DeviceTransportPort } from './deviceTransport';

/** The transport members the settings UI's car confirmation reads and writes. */
export type CarAssociationUiTarget = Pick<DeviceTransportPort,
  | 'confirmCarAssociation'
  | 'clearCarConfirmation'
  | 'getCarConfirmation'
  | 'getAssociatedCar'
  | 'getSnapshotByDeviceId'
>;

const readNonBlankString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};

/**
 * The charger's car link as it stands after a confirm or clear: the confirmed
 * car, the associated car, and the charger's own resolved battery level.
 */
const readCarAssociation = (
  transport: CarAssociationUiTarget,
  chargerId: string,
): SettingsUiCarAssociationConfirmation => {
  const snapshot = transport.getSnapshotByDeviceId(chargerId);
  return {
    carConfirmation: transport.getCarConfirmation(chargerId),
    associatedCar: transport.getAssociatedCar(chargerId),
    ...(snapshot && hasObservedStateOfCharge(snapshot)
      ? { stateOfCharge: { level: snapshot.stateOfCharge.level } }
      : {}),
  };
};

/**
 * Confirm the car on a charger from the settings UI. The request body crosses
 * the Homey API bridge, so it is validated here before the transport sees it.
 */
export const confirmCarAssociationFromUi = (
  transport: CarAssociationUiTarget,
  body: unknown,
): SettingsUiCarAssociationConfirmation => {
  const chargerId = isUnknownRecord(body) ? readNonBlankString(body, 'chargerId') : null;
  const carId = isUnknownRecord(body) ? readNonBlankString(body, 'carId') : null;
  if (chargerId === null || carId === null) throw new ApiRequestError('Choose a charger and a car.');
  transport.confirmCarAssociation(chargerId, carId);
  return readCarAssociation(transport, chargerId);
};

/** Clear a charger's confirmed car from the settings UI. */
export const clearCarAssociationFromUi = (
  transport: CarAssociationUiTarget,
  body: unknown,
): SettingsUiCarAssociationConfirmation => {
  const chargerId = isUnknownRecord(body) ? readNonBlankString(body, 'chargerId') : null;
  if (chargerId === null) throw new ApiRequestError('Choose a charger.');
  transport.clearCarConfirmation(chargerId);
  return readCarAssociation(transport, chargerId);
};

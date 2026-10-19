import type Homey from 'homey';
import api from '../../api';
import type { DeviceTransportPort } from '../../lib/device/deviceTransport';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { Logger } from '../../lib/logging/logger';
import { ApiRequestError } from '../../lib/utils/apiRequestError';
import { partialDouble } from '../helpers/partialDouble';
import { pelsHostDouble } from '../helpers/pelsHostDouble';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';

function fixture() {
  const confirm = vi.fn<DeviceTransportPort['confirmCarAssociation']>();
  const clear = vi.fn<DeviceTransportPort['clearCarConfirmation']>();
  const carConfirmation = { carId: 'polestar', carName: 'Polestar', available: true };
  const getCarConfirmation = vi.fn<DeviceTransportPort['getCarConfirmation']>().mockReturnValue(carConfirmation);
  const association = {
    carId: 'polestar', carName: 'Polestar', confirmed: true as const,
    chargingState: 'plugged_out' as const, chargingStateObservedAtMs: 1_000, socPct: 63,
  };
  const getAssociatedCar = vi.fn<DeviceTransportPort['getAssociatedCar']>().mockReturnValue(association);
  // Deliberately distinct from the car decoration: the API must publish the
  // charger's owner-resolved level, not reconstruct it from the car's telemetry.
  const stateOfCharge = stateOfChargeFixture({ percent: 61, observedAtMs: 2_000, carId: 'polestar' });
  const getSnapshotByDeviceId = vi.fn<DeviceTransportPort['getSnapshotByDeviceId']>().mockReturnValue(
    partialDouble<TransportDeviceSnapshot>({ id: 'charger', stateOfCharge }),
  );
  const warn = vi.fn();
  const error = vi.fn();
  const host = pelsHostDouble({
    deviceManager: partialDouble<DeviceTransportPort>({
      confirmCarAssociation: confirm, clearCarConfirmation: clear, getCarConfirmation, getAssociatedCar, getSnapshotByDeviceId,
    }),
    getApiStructuredLogger: () => partialDouble<Logger>({ warn, error }),
  });
  const homey = { app: host } as unknown as Homey.App['homey'];
  return { homey, confirm, clear, carConfirmation, getCarConfirmation, getAssociatedCar, getSnapshotByDeviceId, association, stateOfCharge, warn, error };
}

test('confirmation returns the associated car and the authoritative charger level', async () => {
  const fixtureState = fixture();
  const { homey, confirm, getSnapshotByDeviceId, association, stateOfCharge, carConfirmation } = fixtureState;
  await expect(api.ui_car_association_confirm({
    homey, body: { chargerId: 'charger', carId: 'polestar' },
  })).resolves.toEqual({ carConfirmation, associatedCar: association, stateOfCharge: { level: stateOfCharge.level } });
  expect(confirm).toHaveBeenCalledExactlyOnceWith('charger', 'polestar');
  expect(getSnapshotByDeviceId).toHaveBeenCalledExactlyOnceWith('charger');
});

test.each([
  undefined, null, [], {},
  { chargerId: '', carId: 'polestar' },
  { chargerId: '  ', carId: 'polestar' },
  { chargerId: 42, carId: 'polestar' },
  { chargerId: 'charger', carId: '' },
  { chargerId: 'charger', carId: '  ' },
  { chargerId: 'charger', carId: 42 },
])('rejects malformed confirmation input before invoking the domain: %j', async (body) => {
  const { homey, confirm, getSnapshotByDeviceId, warn, error } = fixture();
  await expect(api.ui_car_association_confirm({ homey, body })).rejects.toBeInstanceOf(ApiRequestError);
  expect(confirm).not.toHaveBeenCalled();
  expect(getSnapshotByDeviceId).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'api_request_rejected' }));
  expect(error).not.toHaveBeenCalled();
});

test('propagates a domain refusal without returning a successful confirmation', async () => {
  const { homey, confirm, getAssociatedCar, getSnapshotByDeviceId } = fixture();
  const failure = new Error('The charger is not connected.');
  confirm.mockImplementation(() => { throw failure; });
  await expect(api.ui_car_association_confirm({
    homey, body: { chargerId: 'charger', carId: 'polestar' },
  })).rejects.toBe(failure);
  expect(getAssociatedCar).not.toHaveBeenCalled();
  expect(getSnapshotByDeviceId).not.toHaveBeenCalled();
});


test('clearing returns the authoritative empty confirmation and telemetry', async () => {
  const { homey, clear, getCarConfirmation, getAssociatedCar, getSnapshotByDeviceId } = fixture();
  getCarConfirmation.mockReturnValue(undefined);
  getAssociatedCar.mockReturnValue(undefined);
  getSnapshotByDeviceId.mockReturnValue(partialDouble<TransportDeviceSnapshot>({ id: 'charger' }));
  await expect(api.ui_car_association_clear({ homey, body: { chargerId: 'charger' } }))
    .resolves.toEqual({ carConfirmation: undefined, associatedCar: undefined });
  expect(clear).toHaveBeenCalledExactlyOnceWith('charger');
});

test.each([undefined, null, [], {}, { chargerId: '' }, { chargerId: '  ' }, { chargerId: 42 }])(
  'rejects malformed clear input before invoking the domain: %j', async (body) => {
    const { homey, clear, getSnapshotByDeviceId } = fixture();
    await expect(api.ui_car_association_clear({ homey, body })).rejects.toBeInstanceOf(ApiRequestError);
    expect(clear).not.toHaveBeenCalled();
    expect(getSnapshotByDeviceId).not.toHaveBeenCalled();
  },
);

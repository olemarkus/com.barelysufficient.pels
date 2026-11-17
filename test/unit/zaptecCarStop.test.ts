import { ZaptecCarStops } from '../../lib/device/zaptec/carStop';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { EvChargingState } from '../../packages/contracts/src/types';

const REFUSAL = 'HTTP 500: Charging is not Paused nor Scheduled; Resume command cannot be sent';
const TURN_ON = { capabilityId: 'evcharger_charging', value: true };
const snapshot = (evChargingState: EvChargingState) => ({ id: 'zaptec', evChargingState }) as TransportDeviceSnapshot;

describe('ZaptecCarStops', () => {
  it('ends the stop on any state but paused, so a later pause by someone else is not the car', () => {
    // A full read reaches `noteRead` only while the live feed is trusted; the
    // projection alone must end the stop when the session has moved on.
    const stops = new ZaptecCarStops();
    stops.noteRefused('zaptec', TURN_ON, REFUSAL, 1000);
    expect(stops.project(snapshot('plugged_in_paused')).evChargingState).toBe('plugged_in_car_stopped');

    expect(stops.project(snapshot('plugged_in_charging')).evChargingState).toBe('plugged_in_charging');
    expect(stops.has('zaptec')).toBe(false);
    expect(stops.project(snapshot('plugged_in_paused')).evChargingState).toBe('plugged_in_paused');
  });

  it('keeps the stop while the snapshot already reads car-stopped', () => {
    const stops = new ZaptecCarStops();
    stops.noteRefused('zaptec', TURN_ON, REFUSAL, 1000);
    expect(stops.project(snapshot('plugged_in_car_stopped')).evChargingState).toBe('plugged_in_car_stopped');
    expect(stops.has('zaptec')).toBe(true);
  });

  it('records only the car-stopped refusal of a turn-on', () => {
    const stops = new ZaptecCarStops();
    expect(stops.noteRefused('zaptec', { capabilityId: 'evcharger_charging', value: false }, REFUSAL, 1000)).toBe(false);
    expect(stops.noteRefused('zaptec', { capabilityId: 'target_power', value: 1380 }, REFUSAL, 1000)).toBe(false);
    expect(stops.noteRefused('zaptec', TURN_ON, 'HTTP 500: timeout', 1000)).toBe(false);
    expect(stops.noteRefused('zaptec', { capabilityId: 'charging_button', value: true }, REFUSAL, 1000)).toBe(true);
  });

  it.each([
    'HTTP 500: Failed to turn on the charger: the car stopped charging by itself, for example because it is full',
    'HTTP 500: Kunne ikke starte lading: bilen sluttet å lade av seg selv, for eksempel fordi den er full',
  ])('records the app\'s translated car-stopped answer: %s', (message) => {
    const stops = new ZaptecCarStops();
    expect(stops.noteRefused('zaptec', TURN_ON, message, 1000)).toBe(true);
    expect(stops.project(snapshot('plugged_in_paused')).evChargingState).toBe('plugged_in_car_stopped');
  });

  it.each(['alarm_generic.car_connected', 'charge_mode', 'charging_button'])('ends on a %s report', (capabilityId) => {
    const stops = new ZaptecCarStops();
    stops.noteRefused('zaptec', TURN_ON, REFUSAL, 1000);
    stops.noteReport('zaptec', capabilityId);
    expect(stops.project(snapshot('plugged_in_car_stopped')).evChargingState).toBe('plugged_in_paused');
    expect(stops.has('zaptec')).toBe(false);
  });

  it('ignores reports that say nothing about the session', () => {
    const stops = new ZaptecCarStops();
    stops.noteRefused('zaptec', TURN_ON, REFUSAL, 1000);
    stops.noteReport('zaptec', 'measure_power');
    expect(stops.project(snapshot('plugged_in_paused')).evChargingState).toBe('plugged_in_car_stopped');
  });
});

import { chargingRecommendations } from '../src/ui/chargingRecommendations.ts';
import type { ChargingCurrentRead } from '../../contracts/src/chargingControl.ts';
const device: ChargingCurrentRead = { deviceId: 'charger', name: 'Garage', setup: {
  method: 'flow', confirmation: 'none',
}, capabilityWritable: false, scope: 'installation', sharedInstallation: false,
flowCheck: 'clear', flowNames: [], currentRoute: 'flow', missingCompanion: 'none' };

test('recommends a key and offers no Flow to a charger nothing controls', () => {
  const [recommendation] = chargingRecommendations([device], { configured: false, state: 'not_configured' });
  expect(recommendation?.body).toContain('Nothing changes the charging current of this device yet.');
  expect(recommendation?.body).toContain('API key');
  expect(recommendation?.body).not.toMatch(/keep a|current-setting Flow/);
});
test.each([false, true])('keeps a working Flow after the owner chooses Use a Flow (writable: %s)', (writable) => {
  const flow = { ...device, capabilityWritable: writable, flowCheck: 'conflict' as const };
  const access = { configured: !writable, state: writable ? 'not_configured' as const : 'ready' as const };
  const [paused] = chargingRecommendations([{
    ...flow, setup: { method: 'built_in', confirmation: 'single_charger' },
  }], access);
  expect(paused?.body).toContain('To keep the Flow instead, choose Use a Flow');
  expect(chargingRecommendations([flow], access)).toEqual([]);
});
test('keeps vehicle consent visible beside an existing current-setting Flow', () => {
  const car: ChargingCurrentRead = { ...device, scope: 'vehicle', flowCheck: 'conflict' };
  expect(chargingRecommendations([car], { configured: true, state: 'ready' }).map(({ id }) => id))
    .toEqual(['charging-owner:charger']);
});
test('a selected built-in route held back by a Flow says it is paused without asking to switch again', () => {
  const [recommendation] = chargingRecommendations([{ ...device, flowCheck: 'conflict', currentRoute: 'flow',
    setup: { method: 'built_in', confirmation: 'single_charger' } }], { configured: false, state: 'not_configured' });
  expect(recommendation?.id).toContain('charging-paused');
  expect(recommendation?.title).toBe('Built-in current control is paused for Garage');
  expect(recommendation?.body).toContain('PELS cannot stop a Flow');
  expect(recommendation?.body).toContain('Use a Flow');
  expect(recommendation?.body).not.toContain('explicitly choose built-in control');
});
test('a writable capability does not prompt for a key', () => {
  const [recommendation] = chargingRecommendations([{ ...device, capabilityWritable: true }], { configured: false, state: 'not_configured' });
  expect(recommendation?.body).not.toContain('key');
});
test('shared installations retain Flow control without a built-in recommendation', () => {
  expect(chargingRecommendations([{ ...device, sharedInstallation: true }], { configured: true, state: 'ready' })).toEqual([]);
});
test('a car PELS controls without its location device gets its own dismissable advice', () => {
  const car: ChargingCurrentRead = { ...device, deviceId: 'tesla', name: 'Model Y', scope: 'vehicle',
    setup: { method: 'built_in', confirmation: 'vehicle' }, currentRoute: 'built_in', missingCompanion: 'vehicle_location' };
  const recommendations = chargingRecommendations([car], { configured: true, state: 'ready' });
  expect(recommendations).toEqual([expect.objectContaining({
    id: 'charging-vehicle-location:tesla', version: 1, category: 'recommendation',
    title: 'Add the location device for Model Y', target: { kind: 'device', deviceId: 'tesla' },
  })]);
  expect(recommendations[0]?.body).toContain('Location & navigation');
});
test('the location advice waits until the owner chooses to control charging through the car', () => {
  const car: ChargingCurrentRead = { ...device, scope: 'vehicle', missingCompanion: 'vehicle_location' };
  expect(chargingRecommendations([car], { configured: true, state: 'ready' }).map(({ id }) => id))
    .toEqual(['charging-owner:charger']);
});
test('missing vehicle consent links directly to its charging setup', () => {
  const car: ChargingCurrentRead = { ...device, scope: 'vehicle' };
  const [recommendation] = chargingRecommendations([car], { configured: true, state: 'ready' });
  expect(recommendation).toMatchObject({
    actionLabel: 'Finish charging setup',
    target: { kind: 'device', deviceId: car.deviceId, focus: 'charging-control' },
  });
});

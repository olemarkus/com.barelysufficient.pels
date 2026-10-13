import { chargingRecommendations } from '../src/ui/chargingRecommendations.ts';
import type { ChargingCurrentRead } from '../../contracts/src/chargingControl.ts';
const device: ChargingCurrentRead = { deviceId: 'charger', name: 'Garage', setup: {
  method: 'flow', confirmation: 'none',
}, capabilityWritable: false, scope: 'installation', sharedInstallation: false,
flowCheck: 'clear', flowNames: [] };

test('recommends a key while preserving the Flow alternative', () => {
  const [recommendation] = chargingRecommendations([device], { configured: false, state: 'not_configured' });
  expect(recommendation?.body).toContain('API key');
  expect(recommendation?.body).toContain('Flow');
});
test('nudges removal when both a key and a current-setting Flow exist', () => {
  const [recommendation] = chargingRecommendations([{ ...device, flowCheck: 'conflict' }], { configured: true, state: 'ready' });
  expect(recommendation?.id).toContain('charging-remove-flow');
  expect(recommendation?.body).toContain('explicitly choose built-in control');
});
test('an already selected built-in route warns about competing Flow control without asking to switch again', () => {
  const [recommendation] = chargingRecommendations([{ ...device, flowCheck: 'conflict',
    setup: { method: 'built_in', confirmation: 'single_charger' } }], { configured: false, state: 'not_configured' });
  expect(recommendation?.body).toContain('does not compete with built-in control');
  expect(recommendation?.body).not.toContain('choose built-in control');
});
test('a writable capability does not prompt for a key', () => {
  const [recommendation] = chargingRecommendations([{ ...device, capabilityWritable: true }], { configured: false, state: 'not_configured' });
  expect(recommendation?.body).not.toContain('key');
});
test('shared installations retain Flow control without a built-in recommendation', () => {
  expect(chargingRecommendations([{ ...device, sharedInstallation: true }], { configured: true, state: 'ready' })).toEqual([]);
});

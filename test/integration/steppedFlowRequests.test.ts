import { SteppedFlowRequests } from '../../lib/device/transport/steppedFlowRequests';
import type { ChargingCurrentControl } from '../../lib/device/chargingCurrentControl';
import type { TeslaChargingSession } from '../../lib/device/teslaChargingSession';
import type { TransportSnapshotStore } from '../../lib/device/transport/transportSnapshotStore';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import { createSettingsHandler } from '../../lib/utils/settingsHandlers';
import { settingsHandlerDepsDouble } from '../helpers/settingsHandlerDepsDouble';
import { partialDouble } from '../helpers/partialDouble';

function harness() {
  const snapshots = partialDouble<TransportSnapshotStore>({
    getSnapshotByDeviceId: () => partialDouble<TransportDeviceSnapshot>({ available: true, canSetControl: true, binaryControl: { on: false } }),
    getTrackedRawDevice: () => ({ id: 'charger', name: 'Charger' }),
  });
  const current = partialDouble<ChargingCurrentControl>({ generation: 1,
    setup: () => ({ method: 'flow', confirmation: 'single_charger' }),
    assertControlAllowed: () => {},
    homeSession: partialDouble<TeslaChargingSession>({ sessionId: () => 0 }),
  });
  const requests = new SteppedFlowRequests(snapshots, current);
  const handler = createSettingsHandler(settingsHandlerDepsDouble({
    onDeviceControlConfigurationObserved: () => requests.invalidateAll(),
  }));
  return { handler, requests };
}

test.each(['managed_devices', 'controllable_devices', 'device_target_power_configs', 'capacity_dry_run'])(
  'revokes a pending Flow request across %s off/on before its first validity check', async (key) => {
    const { handler, requests } = harness();
    try {
      const id = requests.issue('charger');
      expect(requests.isValid('charger', id)).toBe(true);
      // Real settings events reach this synchronous edge even while their
      // downstream reloads are queued; validity is not checked between them.
      const off = handler(key);
      const on = handler(key);
      expect(requests.isValid('charger', id)).toBe(false);
      await Promise.all([off, on]);
      expect(requests.isValid('charger', id)).toBe(false);
    } finally { handler.stop(); }
  },
);

test('permits a fresh release request after Power-limit control changes', async () => {
  const { handler, requests } = harness();
  try {
    await handler('controllable_devices');
    const id = requests.issue('charger');
    expect(requests.isValid('charger', id)).toBe(true);
  } finally { handler.stop(); }
});

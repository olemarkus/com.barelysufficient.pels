/* eslint-disable @typescript-eslint/no-explicit-any -- Homey Flow APIs are untyped */
import { TargetDeviceSnapshot } from '../types';

type DeviceRef = string | { id?: string; name?: string; data?: { id?: string } };

export function registerExpectedPowerCard(
  homey: { flow: { getActionCard: (id: string) => { registerRunListener: (fn: any) => void; registerArgumentAutocompleteListener: (arg: string, fn: any) => void } } },
  deps: {
    getSnapshot: () => Promise<TargetDeviceSnapshot[]>;
    getDeviceLoadSetting: (deviceId: string) => Promise<number | null>;
    setExpectedOverride: (deviceId: string, kw: number) => void;
    refreshSnapshot: () => Promise<void>;
    rebuildPlan: () => void;
    log: (...args: any[]) => void;
  },
): void {
  const card = homey.flow.getActionCard('set_expected_power_usage');

  card.registerRunListener(async (args: { device: DeviceRef; power_w: number }) => {
    const deviceIdRaw = typeof args.device === 'object' && args.device !== null
      ? args.device.id || args.device.data?.id
      : args.device;
    const deviceId = (deviceIdRaw || '').trim();
    if (!deviceId) throw new Error('Device must be provided');

    const powerW = Number(args.power_w);
    if (!Number.isFinite(powerW) || powerW <= 0) {
      throw new Error('Expected power must be a positive number (W).');
    }

    const configuredLoad = await deps.getDeviceLoadSetting(deviceId);
    if (configuredLoad !== null && configuredLoad > 0) {
      throw new Error('Device already has load configured in settings; remove it before overriding expected power.');
    }

    const snapshot = await deps.getSnapshot();
    const deviceName = snapshot.find((d) => d.id === deviceId)?.name || deviceId;
    deps.setExpectedOverride(deviceId, powerW / 1000);
    deps.log(`Flow: set expected power for ${deviceName} to ${(powerW / 1000).toFixed(3)} kW`);
    await deps.refreshSnapshot();
    deps.rebuildPlan();
    return true;
  });

  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const q = (query || '').toLowerCase();
    const snapshot = await deps.getSnapshot();
    return snapshot
      .filter((d) => !d.loadKw || d.loadKw <= 0)
      .map((d) => ({ id: d.id, name: d.name || d.id }))
      .filter((d) => !q || d.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

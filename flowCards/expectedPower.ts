import { FlowCard, FlowHomeyLike, TargetDeviceSnapshot } from '../lib/utils/types';

type DeviceRef = string | { id?: string; name?: string; data?: { id?: string } };

type ActionCardHomey = Pick<FlowHomeyLike, 'flow'> & {
  flow: { getActionCard: (id: string) => FlowCard };
};

function extractDeviceId(payload: { device?: DeviceRef } | null): string {
  const deviceIdRaw = typeof payload?.device === 'object' && payload?.device !== null
    ? payload.device.id || payload.device.data?.id
    : payload?.device;
  const deviceId = (deviceIdRaw || '').trim();
  if (!deviceId) throw new Error('Device must be provided');
  return deviceId;
}

function parseExpectedPowerW(payload: { power_w?: number } | null): number {
  const powerW = Number(payload?.power_w);
  if (!Number.isFinite(powerW) || powerW <= 0) {
    throw new Error('Expected power must be a positive number (W).');
  }
  return powerW;
}

async function assertNoConfiguredLoad(
  deps: {
    getDeviceLoadSetting: (deviceId: string) => Promise<number | null>;
  },
  deviceId: string,
): Promise<void> {
  const configuredLoad = await deps.getDeviceLoadSetting(deviceId);
  if (configuredLoad !== null && configuredLoad > 0) {
    throw new Error('Device already has load configured in settings; remove it before overriding expected power.');
  }
}

function resolveDeviceName(snapshot: TargetDeviceSnapshot[], deviceId: string): string {
  return snapshot.find((d) => d.id === deviceId)?.name || deviceId;
}

export function registerExpectedPowerCard(
  homey: ActionCardHomey,
  deps: {
    getSnapshot: () => Promise<TargetDeviceSnapshot[]>;
    getDeviceLoadSetting: (deviceId: string) => Promise<number | null>;
    setExpectedOverride: (deviceId: string, kw: number) => void;
    refreshSnapshot: () => Promise<void>;
    rebuildPlan: () => void;
    log: (...args: unknown[]) => void;
  },
): void {
  const card = homey.flow.getActionCard('set_expected_power_usage');

  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: DeviceRef; power_w?: number } | null;
    const deviceId = extractDeviceId(payload);
    const powerW = parseExpectedPowerW(payload);
    await assertNoConfiguredLoad(deps, deviceId);

    const snapshot = await deps.getSnapshot();
    const deviceName = resolveDeviceName(snapshot, deviceId);
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

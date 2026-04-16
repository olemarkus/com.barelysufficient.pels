import { FlowCard, FlowHomeyLike, TargetDeviceSnapshot } from '../lib/utils/types';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';

type DeviceRef = RawFlowDeviceArg;

type ActionCardHomey = Pick<FlowHomeyLike, 'flow'> & {
  flow: { getActionCard: (id: string) => FlowCard };
};

function extractDeviceId(payload: { device?: DeviceRef } | null): string {
  const deviceId = getDeviceIdFromFlowArg(payload?.device);
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
    getSnapshot: () => Promise<TargetDeviceSnapshot[]>;
    getDeviceLoadSetting: (deviceId: string) => Promise<number | null>;
  },
  deviceId: string,
): Promise<void> {
  const snapshot = await deps.getSnapshot();
  const device = snapshot.find((entry) => entry.id === deviceId);
  if (device?.controlModel === 'stepped_load') {
    throw new Error(
      'Stepped load devices use configured planning power per step; '
      + 'expected power override is not supported.',
    );
  }
  const configuredLoad = await deps.getDeviceLoadSetting(deviceId);
  if (configuredLoad !== null && configuredLoad > 0) {
    throw new Error('Device already has load configured in settings; remove it before overriding expected power.');
  }
}

function resolveDeviceName(snapshot: TargetDeviceSnapshot[], deviceId: string): string {
  const device = snapshot.find((d) => d.id === deviceId);
  return device ? device.name : `device ${deviceId}`;
}

export function registerExpectedPowerCard(
  homey: ActionCardHomey,
  deps: {
    getSnapshot: () => Promise<TargetDeviceSnapshot[]>;
    getDeviceLoadSetting: (deviceId: string) => Promise<number | null>;
    setExpectedOverride: (deviceId: string, kw: number) => boolean;
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
    const requestedKw = powerW / 1000;
    await assertNoConfiguredLoad(deps, deviceId);

    const snapshot = await deps.getSnapshot();
    const changed = deps.setExpectedOverride(deviceId, requestedKw);
    if (!changed) {
      return true;
    }
    const deviceName = resolveDeviceName(snapshot, deviceId);
    deps.log(`Flow: set expected power for ${deviceName} to ${requestedKw.toFixed(3)} kW`);
    await deps.refreshSnapshot();
    deps.rebuildPlan();
    return true;
  });

  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(
      snapshot
        .filter((d) => d.controlModel !== 'stepped_load')
        .filter((d) => !d.loadKw || d.loadKw <= 0),
      query,
    );
  });
}

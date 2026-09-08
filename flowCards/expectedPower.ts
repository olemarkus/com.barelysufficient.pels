import type { DeviceDescriptorRead } from '../packages/contracts/src/types';
import type { FlowCard, FlowHomeyLike } from '../lib/utils/types';
import type { Logger as PinoLogger } from '../lib/logging/logger';
import { isObserveOnlyRoleClassKey } from '../lib/device/transport/managerHelpers';
import { isSteppedLoadSnapshot } from '../packages/shared-domain/src/steppedLoadObservedState';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';

type DeviceRef = RawFlowDeviceArg;

/**
 * The snapshot this card reads is the decorated carrier, whose stepped
 * descriptor is optional — widened with the probe so `isSteppedLoadSnapshot`
 * can narrow it. The base snapshot type omits `steppedLoadProfile` outright.
 */
// Was a local `TargetDeviceSnapshot & SteppedLoadDescriptorProbe`, which is the
// descriptor read's shape spelled by hand on top of the whole snapshot. This card
// asks two descriptor questions — is the device stepped, and what is it called.
type ExpectedPowerDeviceSnapshot = DeviceDescriptorRead;

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

/**
 * A stepped-load device is sized per configured step, so a single whole-device
 * figure has nothing to apply to.
 *
 * The old sibling guard — refusing the override while `settings.load > 0` — is
 * gone. A manual value now outranks `settings.load` in the one expected-power
 * ladder (`lib/device/devicePowerEstimate.ts`), so refusing to accept one from a
 * device that declares a load made the ladder's top rung unreachable for exactly
 * the owner most likely to need it: someone whose declared load is wrong.
 */
async function assertOverrideSupported(
  deps: { getDeviceDescriptors: () => Promise<ExpectedPowerDeviceSnapshot[]> },
  deviceId: string,
): Promise<void> {
  const descriptors = await deps.getDeviceDescriptors();
  const device = descriptors.find((entry) => entry.id === deviceId);
  if (device && isSteppedLoadSnapshot(device)) {
    throw new Error(
      'Stepped load devices use configured planning power per step; '
      + 'expected power override is not supported.',
    );
  }
}

function resolveDeviceName(devices: DeviceDescriptorRead[], deviceId: string): string | null {
  const device = devices.find((d) => d.id === deviceId);
  return device ? device.name : null;
}

export function registerExpectedPowerCard(
  homey: ActionCardHomey,
  deps: {
    getDeviceDescriptors: () => Promise<ExpectedPowerDeviceSnapshot[]>;
    setExpectedOverride: (deviceId: string, kw: number) => boolean;
    refreshSnapshot: () => Promise<void>;
    rebuildPlan: () => void;
    getStructuredLogger: (component: string) => PinoLogger | undefined;
  },
): void {
  const card = homey.flow.getActionCard('set_expected_power_usage');

  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: DeviceRef; power_w?: number } | null;
    const deviceId = extractDeviceId(payload);
    const powerW = parseExpectedPowerW(payload);
    const requestedKw = powerW / 1000;
    await assertOverrideSupported(deps, deviceId);

    const descriptors = await deps.getDeviceDescriptors();
    const changed = deps.setExpectedOverride(deviceId, requestedKw);
    if (!changed) {
      return true;
    }
    const deviceName = resolveDeviceName(descriptors, deviceId);
    deps.getStructuredLogger('devices')?.info({
      event: 'flow_expected_power_set',
      deviceId,
      deviceName,
      expectedPowerKw: requestedKw,
    });
    await deps.refreshSnapshot();
    deps.rebuildPlan();
    return true;
  });

  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const descriptors = await deps.getDeviceDescriptors();
    return buildDeviceAutocompleteOptions(
      // An observe-only role device (home battery / PV) is force-managed but
      // non-controllable, so an expected-power override on it is a no-op pick.
      // Keyed on the immutable observe-only ROLE (same predicate as the
      // settings-UI hide + deviceSettingsCards), not on the live flag.
      // A configured `loadKw` no longer excludes a device: a manual value
      // outranks `settings.load`, so overriding a wrong declared load is the
      // point rather than a conflict.
      descriptors.filter(
        (d) => !isObserveOnlyRoleClassKey(d.deviceClass)
          && !isSteppedLoadSnapshot(d),
      ),
      query,
    );
  });
}

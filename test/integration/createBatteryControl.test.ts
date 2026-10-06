// Main's battery control owner as setup builds it: the owner reads the
// battery through the device transport and Main-home membership through the
// settled-membership predicate of `lib/home`.
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../lib/app/appContext';
import { BatteryManagedSettings } from '../../lib/battery/batteryControlSettings';
import type { HomeMembershipPort } from '../../lib/home/membership';
import type { BatteryControlRead } from '../../lib/ports/batteryControlOwner';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import { createMainBatteryControl } from '../../setup/appInit/createBatteryControl';

const BATTERY = 'battery-1';

const settingsStore = (): SettingsPort => {
  const values = new Map<string, unknown>([['capacity_limit_kw', 10]]);
  return {
    get: (key) => (values.has(key) ? values.get(key) : null),
    set: (key, value) => { values.set(key, value); },
    unset: (key) => { values.delete(key); },
    getKeys: () => [...values.keys()],
  };
};

const battery: BatteryControlRead = {
  kind: 'setpoint',
  surface: {
    kind: 'setpoint',
    claim: {
      capabilityId: 'target_power_mode',
      homeyValue: 'homey',
      values: ['homey', 'anti_feed'],
      rejection: 'unanswered',
    },
    range: { minW: -2500, maxW: 2500, stepW: 1, excludeMinW: 0, excludeMaxW: 0 },
  },
  claim: { value: 'anti_feed', observedAtMs: Date.now() - 60_000 },
};

describe('createMainBatteryControl', () => {
  it('admits no claim while the battery\'s Main-home membership is not settled', () => {
    let pendingOwnership = true;
    const settings = settingsStore();
    const membership = {
      isOwnershipReady: () => true,
      hasPendingOwnershipGeneration: () => pendingOwnership,
      getHomeIdForDevice: () => 'main',
    } as unknown as HomeMembershipPort;
    const ctx = {
      homey: { settings, flow: { getTriggerCard: vi.fn() } },
      batteryManaged: new BatteryManagedSettings(settings),
      deviceManager: { readBatteryControl: () => battery, requestSteppedLoadStep: vi.fn() },
      homeMembership: membership,
      capacityDryRun: false,
    } as unknown as AppContext;
    const owner = createMainBatteryControl(ctx, () => false);

    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'refused', reason: 'not_main_home' });
    pendingOwnership = false;
    expect(owner.admitClaim(BATTERY)).toEqual({ status: 'admitted' });
  });
});

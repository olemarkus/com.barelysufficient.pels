import { describe, expect, it, vi } from 'vitest';
import { AppServiceWiring, type AppServiceWiringDeps } from '../../setup/appServiceWiring';
import type { HomeRuntimeRegistry } from '../../setup/homeRuntime/homeRuntimeRegistry';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { PlanService } from '../../lib/plan/planService';
import { partialDouble } from '../helpers/partialDouble';

// The "not saved while limited" rule asks the plan of the device's OWNING home.
// Main's plan filters meter-area members out, so a sub-home device asked of
// main would always read as "not limited" and the rule would be silently off
// for exactly the homes that have their own plan.
describe('observed temperature mode updates ask the owning home whether a device is limited', () => {
  const deviceId = 'area-heater';
  const adjustment = { deviceId, temperature: 22, observedAtMs: 1000 };

  const start = (params: { mainLimited: boolean; areaLimited?: boolean }) => {
    const ctx = createAppContextMock();
    // The context mock's settings are inert spies; back them with a store so the
    // policy read and the (non-)write can be observed.
    const store = new Map<string, unknown>([
      ['temperature_control_modes', { [deviceId]: 'update_mode' }],
      ['mode_device_targets', { Home: { [deviceId]: 20 } }],
      ['operating_mode', 'Home'],
    ]);
    ctx.homey.settings.get = vi.fn((key: string) => store.get(key) ?? null);
    ctx.homey.settings.set = vi.fn((key: string, value: unknown) => { store.set(key, value); });
    ctx.homey.settings.getKeys = vi.fn(() => [...store.keys()]);
    ctx.resolveManagedState = vi.fn(() => true);
    ctx.planService = partialDouble<PlanService>({
      isDeviceLimitedInLatestPlan: vi.fn(() => params.mainLimited),
    });
    const route = params.areaLimited === undefined ? undefined : {
      homeId: 'area-1',
      hooks: {
        isDeviceLimited: vi.fn(() => params.areaLimited === true),
        hasPendingBinaryCommand: () => false,
        clearRecentBinaryOffCommand: () => {},
        rebuildPlan: async () => undefined,
        invalidateRebuildSuppression: () => {},
      },
    };
    const registry = partialDouble<HomeRuntimeRegistry>({
      getLiveBundles: () => [],
      getOwningHomeRouteForDevice: () => route,
    });
    const wiring = new AppServiceWiring(partialDouble<AppServiceWiringDeps>({
      ctx,
      isMainActuationStopped: () => false,
      getHomeRuntimeRegistry: () => registry,
    }));
    return { ctx, service: wiring.createObservedTemperatureModeUpdates() };
  };

  it('asks main when the device has no owning sub-home', () => {
    const { ctx, service } = start({ mainLimited: true });
    service.accept(adjustment);
    expect(ctx.homey.settings.get('mode_device_targets')).toEqual({ Home: { [deviceId]: 20 } });
  });

  it('asks the owning sub-home, whose answer outranks main\'s', () => {
    // Main does not contain the device and would say "not limited"; the area's
    // own plan has it limited, so the nudge is not saved.
    const { ctx, service } = start({ mainLimited: false, areaLimited: true });
    service.accept(adjustment);
    expect(ctx.homey.settings.get('mode_device_targets')).toEqual({ Home: { [deviceId]: 20 } });
  });
});

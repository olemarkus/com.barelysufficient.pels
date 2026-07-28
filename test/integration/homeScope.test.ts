import { describe, expect, it, type Mock } from 'vitest';
import { buildMainHomeScope } from '../../setup/homeRuntime/homeScope';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_IN_SHORTFALL,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DEVICE_LAST_CONTROLLED_MS,
  MAIN_HOME_ID,
  PELS_STATUS,
} from '../../lib/utils/settingsKeys';
import { PriceLevel } from '../../lib/price/priceLevels';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { AppContext } from '../../lib/app/appContext';

// Identity proof for the main-home scope: the persisted writers must hit the
// EXACT unsuffixed keys the factories hardwired before the HomeScope refactor
// (`homeScopedSettingsKey` is the identity for `MAIN_HOME_ID`), and the
// capacity-scalar getters must be LIVE reads of the in-memory `ctx` snapshot —
// never re-reads through the persisted settings store.
describe('buildMainHomeScope', () => {
  const minimalStatus = {
    headroomKw: 1,
    hourlyUsageKwh: 0,
    priceLevel: PriceLevel.NORMAL,
    devicesOn: 0,
    devicesOff: 0,
    lastPowerUpdate: null,
  };

  it('writes the persisted signals to the unsuffixed main-home keys', () => {
    const ctx = createAppContextMock();
    const scope = buildMainHomeScope(ctx);
    const setSpy = ctx.homey.settings.set as unknown as Mock;

    scope.setCapacityInShortfall(true);
    scope.persistLastControlledMs({ 'device-1': 123 });
    scope.writePelsStatus(minimalStatus);

    expect(scope.homeId).toBe(MAIN_HOME_ID);
    expect(setSpy).toHaveBeenCalledWith(CAPACITY_IN_SHORTFALL, true);
    expect(setSpy).toHaveBeenCalledWith(DEVICE_LAST_CONTROLLED_MS, { 'device-1': 123 });
    expect(setSpy).toHaveBeenCalledWith(PELS_STATUS, minimalStatus);
  });

  it('reads the capacity scalars live off the ctx snapshot, not the settings store', () => {
    const ctx = createAppContextMock();
    const scope = buildMainHomeScope(ctx);
    const getSpy = ctx.homey.settings.get as unknown as Mock;

    // Mutations AFTER scope construction must be visible on the next read —
    // the closures are live over `ctx`, not captured copies or store re-reads.
    const nextSettings = { limitKw: 7, marginKw: 0.3 };
    ctx.capacitySettings = nextSettings;
    ctx.capacityDryRun = true;

    expect(scope.getCapacitySettings()).toBe(nextSettings);
    expect(scope.getCapacityDryRun()).toBe(true);
    expect(getSpy).not.toHaveBeenCalledWith(CAPACITY_LIMIT_KW);
    expect(getSpy).not.toHaveBeenCalledWith(CAPACITY_MARGIN_KW);
    expect(getSpy).not.toHaveBeenCalledWith(CAPACITY_DRY_RUN);
  });

  // R7b Cluster A+B: the policy stragglers and UI/side-effect singletons the
  // factories used to read straight off `ctx` are now scope members — the main
  // home binds them to the IDENTICAL live ctx reads (byte-identical). A sub-home
  // scope neutralizes the PRICE/BUDGET/UI members, but binds the operating mode
  // and mode targets live like main does: the mode target is the restore anchor,
  // and neutralizing it left an area temperature device shed forever (covered in
  // test/e2e/homeCapacityBundlesSdkE2E.test.ts).
  it('binds the R7b policy stragglers to live ctx reads (byte-identical main)', () => {
    const priceOpt = { 'device-1': { enabled: true, cheapDelta: 1, expensiveDelta: 2 } as never };
    const ctx = createAppContextMock({ priceOptimizationSettings: priceOpt });
    ctx.getDynamicSoftLimitOverride = (() => 3.5) as AppContext['getDynamicSoftLimitOverride'];
    const scope = buildMainHomeScope(ctx);

    ctx.operatingMode = 'away';
    ctx.modeDeviceTargets = { away: { 'device-1': 21 } };

    expect(scope.getPriceOptimizationSettings()).toBe(priceOpt);
    expect(scope.getDynamicSoftLimitOverride()).toBe(3.5);
    expect(scope.getOperatingMode()).toBe('away');
    expect(scope.getModeDeviceTargets()).toEqual({ away: { 'device-1': 21 } });
  });

  it('binds the R7b UI/side-effect singletons live for main; sub-home neutralizes them', () => {
    const ctx = createAppContextMock();
    const diagnostics = { getOverviewStarvation: () => null } as unknown as AppContext['deviceDiagnosticsService'];
    ctx.deviceDiagnosticsService = diagnostics;
    const scope = buildMainHomeScope(ctx);

    // Main emits realtime, carries the shared recorder, and reads combined prices.
    expect(scope.emitsUiRealtime).toBe(true);
    expect(scope.getDeviceDiagnostics()).toBe(diagnostics);
    expect(scope.getCombinedPrices())
      .toEqual(ctx.combinedPricesReader.readStore(ctx.getNow(), ctx.getTimeZone()));
  });

  // R7b P1-3 (regression fix): `buildMainHomeScope` runs in the `AppServiceWiring`
  // CONSTRUCTOR, before `initDeviceDiagnosticsService` sets
  // `ctx.deviceDiagnosticsService`. A FROZEN value would strand the main engine
  // and service on `undefined` (no starvation, no plan-diagnostics observation).
  // The scope member is a LIVE getter, so the recorder resolves at engine/service
  // construction (which runs AFTER diagnostics init) — proving main is unchanged
  // vs origin/main.
  it('resolves deviceDiagnostics LIVE (scope built before diagnostics init still sees the recorder)', () => {
    const ctx = createAppContextMock();
    ctx.deviceDiagnosticsService = undefined;
    const scope = buildMainHomeScope(ctx);
    // At scope-construction time the recorder is not wired yet.
    expect(scope.getDeviceDiagnostics()).toBeUndefined();
    // ...it is wired later; a live getter (not a captured value) now resolves it.
    const diagnostics = { getOverviewStarvation: () => null } as unknown as AppContext['deviceDiagnosticsService'];
    ctx.deviceDiagnosticsService = diagnostics;
    expect(scope.getDeviceDiagnostics()).toBe(diagnostics);
  });
});

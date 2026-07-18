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
});

import { describe, expect, it, vi } from 'vitest';
import { createHomeModeCatalog, type HomeModeCatalog, type HomeModeCatalogSnapshot } from '../../lib/home/homeModeCatalog';
import { HomeModeDeviceResolver } from '../../lib/home/homeModeDeviceRead';
import type { HomeMembershipPort } from '../../lib/home/membership';
import { ModePriorityCatalog } from '../../packages/shared-domain/src/settings/modePriorities';
import { partialDouble } from '../helpers/partialDouble';
import { MockSettings } from '../mocks/homey';
import { testLogger } from '../utils/testLogger';

const membership = (): HomeMembershipPort => partialDouble<HomeMembershipPort>({
  isOwnershipReady: () => true,
  hasPendingOwnershipGeneration: () => false,
  getHomeIdForDevice: (id) => id.startsWith('area-') ? 'h_area' : 'main',
});

const settingsWithModes = (): MockSettings => {
  const settings = new MockSettings();
  settings.set('operating_mode', 'Home');
  settings.set('mode_aliases', {});
  settings.set('capacity_priorities', {
    Home: { 'main-heater': 1, 'area-heater': 8, 'area-tank': 3 },
    Away: { 'main-heater': 1, 'area-heater': 3, 'area-tank': 8 },
    Removed: { 'main-heater': 1 },
  });
  settings.set('mode_device_targets', {
    Home: { 'main-heater': 22, 'area-heater': 21 },
    Away: { 'main-heater': 17, 'area-heater': 16 },
  });
  return settings;
};

const createCatalog = (settings: MockSettings, owners = membership()) => createHomeModeCatalog(
  'main', settings,
  () => { throw new Error('Main has no parent catalog'); },
  () => ({ 'main-heater': true, 'area-heater': true, 'area-tank': true }),
  () => owners,
  () => testLogger,
  () => ({ status: 'resolved', deviceIds: new Set(['battery']) }),
);

describe('device mode diagnostic configuration', () => {
  it('reports the device home and its full-roster ranks while inheriting Main targets', () => {
    const settings = settingsWithModes();
    settings.set('operating_mode:h_area', 'Away');
    const catalog = createCatalog(settings);
    // The ordinary Main view deliberately excludes area devices.
    expect(catalog.getSnapshot().priorities.Home?.['area-heater']).toBeUndefined();
    const set = vi.spyOn(settings, 'set');

    expect(catalog.readDeviceModeConfiguration('area-heater')).toEqual({
      state: 'resolved', homeId: 'h_area', catalogHomeId: 'main', activeMode: 'Away',
      modes: [
        { mode: 'Away', configuredRank: 1, targetTemperatureC: 16 },
        { mode: 'Home', configuredRank: 2, targetTemperatureC: 21 },
      ],
    });
    expect(set).not.toHaveBeenCalled();
  });

  it('reads an independent area catalog instead of Main configuration', () => {
    const settings = settingsWithModes();
    settings.set('mode_catalog_initialized:h_area', true);
    settings.set('mode_aliases:h_area', {});
    settings.set('capacity_priorities:h_area', { Home: { 'area-tank': 1, 'area-heater': 2 } });
    settings.set('mode_device_targets:h_area', { Home: { 'area-heater': 24 } });
    settings.set('operating_mode:h_area', 'Home');

    expect(createCatalog(settings).readDeviceModeConfiguration('area-heater')).toEqual({
      state: 'resolved', homeId: 'h_area', catalogHomeId: 'h_area', activeMode: 'Home',
      modes: [{ mode: 'Home', configuredRank: 2, targetTemperatureC: 24 }],
    });
  });

  it('keeps a blank legacy pin as the existing inherit-Main policy', () => {
    const settings = settingsWithModes();
    settings.set('operating_mode:h_area', '   ');

    expect(createCatalog(settings).readDeviceModeConfiguration('area-heater')).toMatchObject({
      state: 'resolved', activeMode: 'Home', homeId: 'h_area', catalogHomeId: 'main',
    });
  });

  it('does not invent an active or empty-named mode when the governing legacy mode is empty', () => {
    const settings = new MockSettings();
    const snapshot: HomeModeCatalogSnapshot = {
      operatingMode: '', aliases: {}, priorities: {},
      modePriorityCatalog: new ModePriorityCatalog(), targets: { Home: { 'area-heater': 21 } },
    };
    const main = partialDouble<HomeModeCatalog>({
      getSnapshot: () => snapshot,
      resolveModeName: (name) => name,
    });
    const resolver = new HomeModeDeviceResolver(
      settings, main, () => ({ 'area-heater': true }), () => membership(), () => ({ state: 'legacy' }),
    );

    expect(resolver.readConfiguration('area-heater')).toEqual({
      state: 'resolved', homeId: 'h_area', catalogHomeId: 'main', activeMode: null,
      modes: [{ mode: 'Home', configuredRank: 1, targetTemperatureC: 21 }],
    });
  });

  it('leaves an unplaced battery without a configured rank instead of assigning a one-device rank', () => {
    const catalog = createCatalog(settingsWithModes());

    expect(catalog.readDeviceModeConfiguration('battery')).toEqual({
      state: 'resolved', homeId: 'main', catalogHomeId: 'main', activeMode: 'Home',
      modes: [{ mode: 'Away' }, { mode: 'Home' }],
    });
    expect(catalog.getPrioritiesForDevices(['battery', 'main-heater']).getPriority('battery')).toBe(2);
  });

  it.each(['not-ready', 'pending'] as const)('does not assign a home or catalog while ownership is %s', (state) => {
    const owners = membership();
    if (state === 'not-ready') vi.spyOn(owners, 'isOwnershipReady').mockReturnValue(false);
    else vi.spyOn(owners, 'hasPendingOwnershipGeneration').mockReturnValue(true);

    expect(createCatalog(settingsWithModes(), owners).readDeviceModeConfiguration('area-heater'))
      .toEqual({ state: 'unavailable' });
  });

  it('reports a failed initialized-area read as unavailable rather than borrowing Main', () => {
    const settings = settingsWithModes();
    settings.set('mode_catalog_initialized:h_area', true);
    settings.set('mode_aliases:h_area', {});
    settings.set('capacity_priorities:h_area', { Home: { 'area-heater': 1 } });
    settings.set('mode_device_targets:h_area', { Home: { 'area-heater': 24 } });
    const catalog = createCatalog(settings);
    const get = settings.get.bind(settings);
    vi.spyOn(settings, 'get').mockImplementation((key) => {
      if (key === 'capacity_priorities:h_area') throw new Error('read unavailable');
      return get(key);
    });

    expect(catalog.readDeviceModeConfiguration('area-heater')).toEqual({ state: 'unavailable' });
  });
});

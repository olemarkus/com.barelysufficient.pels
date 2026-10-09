// The writers behind the per-device temperature Flow cards. Each writes the
// setting its settings-UI field writes, through the key's owner, and leaves
// every other device's bytes as it found them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editDeviceModeTarget } from '../../lib/home/modeDeviceTargetWrite';
import type { DeviceModeCatalogOutcome } from '../../lib/home/homeModeDeviceRead';
import type { HomeModeCatalogSnapshot } from '../../lib/home/homeModeCatalog';
import { readSmartTaskInProgress } from '../../lib/objectives/deferredObjectives';
import { PER_DEVICE_OBJECTIVE_KEY_PREFIX } from '../../lib/objectives/deferredObjectives/objectiveStore';
import type { DeferredObjectiveSettingsEntry } from '../../packages/contracts/src/deferredObjectiveSettings';
import { partialDouble } from '../helpers/partialDouble';
import { writeDevicePriceAdjustment } from '../../lib/price/priceOptimizationSettingsStore';
import { writeTemperatureControlMode } from '../../lib/device/temperatureControlSettings';
import {
  MODE_DEVICE_TARGETS,
  PRICE_OPTIMIZATION_SETTINGS,
  TEMPERATURE_CONTROL_MODES,
} from '../../lib/utils/settingsKeys';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';

const settings = mockHomeyInstance.settings;

beforeEach(() => {
  resetMockHomey();
  // A real install always holds some key; an empty key list reads as a suspect store.
  settings.set('capacity_limit_kw', 10);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('editDeviceModeTarget', () => {
  const catalogFor = (
    catalogHomeId: string,
    targets: Record<string, Record<string, number>>,
  ): DeviceModeCatalogOutcome => ({
    state: 'resolved',
    catalogHomeId,
    activeMode: 'Home',
    catalog: partialDouble<HomeModeCatalogSnapshot>({ targets, aliases: { holiday: 'Away' } }),
  });

  it('saves one device in the active mode and keeps every other entry', () => {
    const stored = { Home: { heater: 21, other: 20 }, Away: { heater: 16 } };
    settings.set(MODE_DEVICE_TARGETS, stored);

    expect(editDeviceModeTarget(settings, catalogFor('main', stored), 'heater', { kind: 'active' }, 22.5))
      .toEqual({ state: 'written', mode: 'Home' });
    expect(settings.get(MODE_DEVICE_TARGETS)).toEqual({ Home: { heater: 22.5, other: 20 }, Away: { heater: 16 } });
  });

  it('follows an alias and writes a meter area to its own catalog key', () => {
    const stored = { Home: { heater: 21 }, Away: { heater: 16 } };
    settings.set(`${MODE_DEVICE_TARGETS}:h_a`, stored);

    expect(editDeviceModeTarget(settings, catalogFor('h_a', stored), 'heater', { kind: 'named', name: 'Holiday' }, 12))
      .toEqual({ state: 'written', mode: 'Away' });
    expect(settings.get(`${MODE_DEVICE_TARGETS}:h_a`)).toEqual({ Home: { heater: 21 }, Away: { heater: 12 } });
  });

  it('reports an unchanged value without writing', () => {
    const stored = { Home: { heater: 21 } };
    settings.set(MODE_DEVICE_TARGETS, stored);
    const set = vi.spyOn(settings, 'set');

    expect(editDeviceModeTarget(settings, catalogFor('main', stored), 'heater', { kind: 'active' }, 21))
      .toEqual({ state: 'unchanged', mode: 'Home' });
    expect(set).not.toHaveBeenCalled();
  });

  it('never creates a mode: one the catalog lacks, or one removed since it was resolved', () => {
    settings.set(MODE_DEVICE_TARGETS, { Home: { heater: 21 } });
    const resolvedBeforeRemoval = catalogFor('main', { Home: { heater: 21 }, Away: { heater: 16 } });

    expect(editDeviceModeTarget(settings, resolvedBeforeRemoval, 'heater', { kind: 'named', name: 'Cabin' }, 18))
      .toEqual({ state: 'unknown_mode' });
    expect(editDeviceModeTarget(settings, resolvedBeforeRemoval, 'heater', { kind: 'named', name: 'Away' }, 18))
      .toEqual({ state: 'unknown_mode' });
    expect(settings.get(MODE_DEVICE_TARGETS)).toEqual({ Home: { heater: 21 } });
  });

  it('refuses to write when the catalog or the stored targets cannot be read', () => {
    settings.set(MODE_DEVICE_TARGETS, 'not a catalog');

    expect(editDeviceModeTarget(settings, { state: 'unavailable' }, 'heater', { kind: 'active' }, 18))
      .toEqual({ state: 'unavailable' });
    expect(editDeviceModeTarget(settings, catalogFor('main', { Home: {} }), 'heater', { kind: 'active' }, 18))
      .toEqual({ state: 'unavailable' });
    expect(settings.get(MODE_DEVICE_TARGETS)).toBe('not a catalog');
  });
});

describe('writeDevicePriceAdjustment', () => {
  const heater = { enabled: true, cheapDelta: 1, expensiveDelta: -1, priceConfigured: true };
  const other = { enabled: false, cheapDelta: 2, expensiveDelta: -3 };

  it('stores the boost positive and the reduction negative, keeping every other field and device', () => {
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { heater, other });

    expect(writeDevicePriceAdjustment(settings, 'heater', 'cheap_hour_boost', 2)).toBe('written');
    expect(writeDevicePriceAdjustment(settings, 'heater', 'expensive_hour_reduction', 1.5)).toBe('written');
    expect(settings.get(PRICE_OPTIMIZATION_SETTINGS)).toEqual({
      heater: { ...heater, cheapDelta: 2, expensiveDelta: -1.5 },
      other,
    });
  });

  it('stores a zero reduction as 0', () => {
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { heater });

    expect(writeDevicePriceAdjustment(settings, 'heater', 'expensive_hour_reduction', 0)).toBe('written');
    expect(Object.is((settings.get(PRICE_OPTIMIZATION_SETTINGS) as Record<string, typeof heater>).heater.expensiveDelta, 0))
      .toBe(true);
  });

  it('reports an unchanged value without writing', () => {
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { heater });
    const set = vi.spyOn(settings, 'set');

    expect(writeDevicePriceAdjustment(settings, 'heater', 'expensive_hour_reduction', 1)).toBe('unchanged');
    expect(set).not.toHaveBeenCalled();
  });

  it('rewrites a reduction stored with the other sign', () => {
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { heater: { ...heater, expensiveDelta: 1 } });

    expect(writeDevicePriceAdjustment(settings, 'heater', 'expensive_hour_reduction', 1)).toBe('written');
    expect((settings.get(PRICE_OPTIMIZATION_SETTINGS) as Record<string, typeof heater>).heater.expensiveDelta).toBe(-1);
  });

  it('refuses a size outside 0 to 20 °C', () => {
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { heater });

    expect(writeDevicePriceAdjustment(settings, 'heater', 'cheap_hour_boost', 21)).toBe('out_of_range');
    expect(writeDevicePriceAdjustment(settings, 'heater', 'cheap_hour_boost', -1)).toBe('out_of_range');
    expect(settings.get(PRICE_OPTIMIZATION_SETTINGS)).toEqual({ heater });
  });

  it('writes only while Price-based control is on for the device', () => {
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { other });
    expect(writeDevicePriceAdjustment(settings, 'other', 'cheap_hour_boost', 1)).toBe('price_control_off');
    expect(writeDevicePriceAdjustment(settings, 'heater', 'cheap_hour_boost', 1)).toBe('price_control_off');

    settings.unset(PRICE_OPTIMIZATION_SETTINGS);
    expect(writeDevicePriceAdjustment(settings, 'heater', 'cheap_hour_boost', 2)).toBe('price_control_off');
    expect(settings.get(PRICE_OPTIMIZATION_SETTINGS)).toBeNull();
  });

  it('refuses to write over settings it could not read', () => {
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { heater: { enabled: 'yes' } });
    expect(writeDevicePriceAdjustment(settings, 'heater', 'cheap_hour_boost', 2)).toBe('unavailable');

    settings.unset(PRICE_OPTIMIZATION_SETTINGS);
    vi.spyOn(settings, 'getKeys').mockReturnValue([]);
    expect(writeDevicePriceAdjustment(settings, 'heater', 'cheap_hour_boost', 2)).toBe('unavailable');
  });
});

describe('writeTemperatureControlMode', () => {
  it('saves one device and keeps the others', () => {
    settings.set(TEMPERATURE_CONTROL_MODES, { other: 'update_mode' });

    expect(writeTemperatureControlMode(settings, 'heater', 'external', 'none')).toBe('written');
    expect(settings.get(TEMPERATURE_CONTROL_MODES)).toEqual({ other: 'update_mode', heater: 'external' });
  });

  it('starts the key when it was never written', () => {
    expect(writeTemperatureControlMode(settings, 'heater', 'mode', 'none')).toBe('written');
    expect(settings.get(TEMPERATURE_CONTROL_MODES)).toEqual({ heater: 'mode' });
  });

  it('reports an unchanged choice without writing', () => {
    settings.set(TEMPERATURE_CONTROL_MODES, { heater: 'external' });
    const set = vi.spyOn(settings, 'set');

    expect(writeTemperatureControlMode(settings, 'heater', 'external', 'none')).toBe('unchanged');
    expect(set).not.toHaveBeenCalled();
  });

  it('holds the default while a Smart task is in progress, and when that cannot be told', () => {
    settings.set(TEMPERATURE_CONTROL_MODES, { heater: 'mode' });

    expect(writeTemperatureControlMode(settings, 'heater', 'external', 'in_progress')).toBe('blocked_by_smart_task');
    expect(writeTemperatureControlMode(settings, 'heater', 'update_mode', 'unavailable')).toBe('unavailable');
    expect(settings.get(TEMPERATURE_CONTROL_MODES)).toEqual({ heater: 'mode' });

    settings.set(TEMPERATURE_CONTROL_MODES, { heater: 'external' });
    expect(writeTemperatureControlMode(settings, 'heater', 'mode', 'in_progress')).toBe('written');
  });

  it('refuses to write over a policy map it could not read', () => {
    settings.set(TEMPERATURE_CONTROL_MODES, { heater: 'sometimes' });
    expect(writeTemperatureControlMode(settings, 'heater', 'mode', 'none')).toBe('unavailable');
    expect(settings.get(TEMPERATURE_CONTROL_MODES)).toEqual({ heater: 'sometimes' });
  });
});

describe('readSmartTaskInProgress', () => {
  const NOW_MS = Date.UTC(2026, 9, 2, 12, 0, 0);
  const task = (overrides: Partial<DeferredObjectiveSettingsEntry> = {}): DeferredObjectiveSettingsEntry => ({
    enabled: true,
    kind: 'ev_soc',
    enforcement: 'soft',
    targetPercent: 80,
    deadlineAtMs: NOW_MS + 3_600_000,
    ...overrides,
  } as DeferredObjectiveSettingsEntry);
  const keyFor = (deviceId: string): string => `${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${deviceId}`;

  it('is in progress for an enabled task whose ready-by is ahead', () => {
    settings.set(keyFor('heater'), task());
    expect(readSmartTaskInProgress(settings, 'heater', NOW_MS)).toBe('in_progress');
  });

  it('is none for a past or disabled task, and for a device with no task', () => {
    settings.set(keyFor('past'), task({ deadlineAtMs: NOW_MS - 1 }));
    settings.set(keyFor('paused'), task({ enabled: false }));

    expect(readSmartTaskInProgress(settings, 'past', NOW_MS)).toBe('none');
    expect(readSmartTaskInProgress(settings, 'paused', NOW_MS)).toBe('none');
    expect(readSmartTaskInProgress(settings, 'heater', NOW_MS)).toBe('none');
  });

  it('is unavailable when the store cannot prove there is no task', () => {
    settings.set(keyFor('junk'), { kind: 'unknown' });
    expect(readSmartTaskInProgress(settings, 'junk', NOW_MS)).toBe('unavailable');

    vi.spyOn(settings, 'getKeys').mockReturnValue([]);
    expect(readSmartTaskInProgress(settings, 'heater', NOW_MS)).toBe('unavailable');
  });
});

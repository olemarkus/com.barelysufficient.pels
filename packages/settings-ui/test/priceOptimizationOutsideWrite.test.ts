import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';
import { setHomeyClient } from '../src/ui/homey.ts';
import { state } from '../src/ui/state.ts';
import { createSettingsSetHandler } from '../src/ui/settingsChangeRouter.ts';
import {
  reloadPriceOptimizationSettings,
  writePriceOptimizationSettings,
} from '../src/ui/priceConfigSettingsIo.ts';
import { PRICE_OPTIMIZATION_SETTINGS } from '../../contracts/src/settingsKeys.ts';

/* -------------------------------------------------------------------------- *
 * Every page write of `price_optimization_settings` stores the page's whole
 * map. A Flow card also writes the key, so with the page open the page's map
 * has to follow that write, or the owner's next edit to any device puts the
 * Flow's value back the way it was, without a word.
 * -------------------------------------------------------------------------- */

const entry = (cheapDelta: number) => ({
  enabled: true,
  cheapDelta,
  expensiveDelta: -2,
  priceConfigured: true,
  surplusWilling: false,
  surplusDelta: 2,
});

const storedMap = (homey: MockHomeyClient) => (
  homey.__settingsStore[PRICE_OPTIMIZATION_SETTINGS] as Record<string, ReturnType<typeof entry>>
);

describe('the settings page follows outside writes to price_optimization_settings', () => {
  let homey: MockHomeyClient;

  beforeEach(async () => {
    homey = installHomeyMock({
      settings: { [PRICE_OPTIMIZATION_SETTINGS]: { heater: entry(5), pump: entry(2) } },
    });
    setHomeyClient(homey as never);
    state.priceOptimizationSettings = {};
    await reloadPriceOptimizationSettings();
  });

  afterEach(() => {
    setHomeyClient(null);
  });

  it('keeps a Flow\'s value when the owner then edits another device', async () => {
    homey.__settingsStore[PRICE_OPTIMIZATION_SETTINGS] = { heater: entry(7), pump: entry(2) };
    createSettingsSetHandler()(PRICE_OPTIMIZATION_SETTINGS);
    await vi.waitFor(() => expect(state.priceOptimizationSettings.heater?.cheapDelta).toBe(7));

    state.priceOptimizationSettings.pump = entry(3);
    await writePriceOptimizationSettings();

    expect(storedMap(homey).heater?.cheapDelta).toBe(7);
    expect(storedMap(homey).pump?.cheapDelta).toBe(3);
  });

  // Holds the page's next write in flight until the returned function lands it.
  const holdNextWrite = () => {
    let land = () => {};
    homey.set.mockImplementationOnce((key: string, value: unknown, cb: (err: Error | null) => void) => {
      const copy = structuredClone(value);
      land = () => {
        homey.__settingsStore[key] = copy;
        cb(null);
      };
    });
    return () => land();
  };

  it('reads a change notification only after the page\'s own write lands', async () => {
    const land = holdNextWrite();
    state.priceOptimizationSettings.heater = entry(5.5);
    const write = writePriceOptimizationSettings();
    // A read now would still find 5 in the store and undo the edit.
    const reload = reloadPriceOptimizationSettings();
    land();
    await write;

    expect(await reload).toBe(false);
    expect(state.priceOptimizationSettings.heater?.cheapDelta).toBe(5.5);
    expect(storedMap(homey).heater?.cheapDelta).toBe(5.5);
  });

  it('picks up an outside write notified while the page\'s write is in flight', async () => {
    const land = holdNextWrite();
    state.priceOptimizationSettings.pump = entry(3);
    const write = writePriceOptimizationSettings();
    const reload = reloadPriceOptimizationSettings();
    land();
    // The Flow's write lands just after the page's.
    storedMap(homey).heater = entry(7);
    await write;

    expect(await reload).toBe(true);
    expect(state.priceOptimizationSettings.heater?.cheapDelta).toBe(7);
    expect(state.priceOptimizationSettings.pump?.cheapDelta).toBe(3);
  });
});

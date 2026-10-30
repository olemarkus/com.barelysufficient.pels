// Unit coverage for the area-upsert save rules (`lib/home/homeAreaSaveRules.ts`):
// composing the upsert, the forest-root check, and every refusal the composed
// config can earn, in the order the save seam answers them.
import { describe, expect, it, vi } from 'vitest';
import {
  composeAreaUpsert,
  findAreaUpsertRefusal,
  isAreaRootAtForestRoot,
  type ComposedAreaUpsert,
} from '../../lib/home/homeAreaSaveRules';
import type { SubHomeConfig, ZoneTree } from '../../lib/home/homeConfig';
import type { ConfiguredPowerSourceRead } from '../../lib/ports/configuredPowerSource';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../../lib/utils/settingsKeys';
import { HOME_AREA_MAX_COUNT } from '../../packages/shared-domain/src/homeAreaConfigRules';

// house ─┬─ upstairs ── loft
//        └─ garage
const ZONES: ZoneTree = {
  house: { id: 'house', name: 'House', parent: null },
  upstairs: { id: 'upstairs', name: 'Upstairs', parent: 'house' },
  loft: { id: 'loft', name: 'Loft', parent: 'upstairs' },
  garage: { id: 'garage', name: 'Garage', parent: 'house' },
};

const area = (homeId: string, name: string, rootZoneId: string, meterDeviceId: string | null): SubHomeConfig => ({
  homeId, name, rootZoneId, meterDeviceId,
});

const UPSTAIRS = area('h_up000000', 'Upstairs', 'upstairs', 'meter-up');
const GARAGE = area('h_garage00', 'Garage', 'garage', 'meter-garage');

/** Main's meter selection as Homey settings hold it. */
const settingsWithMainMeter = (meterDeviceId: string | null) => ({
  get: (key: string): unknown => (key === HOMEY_ENERGY_METER_DEVICE_ID ? meterDeviceId : undefined),
  getKeys: (): string[] => (meterDeviceId === null ? ['power_source'] : ['power_source', HOMEY_ENERGY_METER_DEVICE_ID]),
});

const homeyEnergy = (): ConfiguredPowerSourceRead => ({ state: 'resolved', value: 'homey_energy' });

const refusalFor = (
  upsert: ComposedAreaUpsert,
  options: {
    zoneTree?: ZoneTree | null;
    mainMeter?: string | null;
    powerSource?: ConfiguredPowerSourceRead;
  } = {},
) => findAreaUpsertRefusal(
  upsert,
  options.zoneTree === undefined ? ZONES : options.zoneTree,
  settingsWithMainMeter(options.mainMeter === undefined ? 'meter-main' : options.mainMeter),
  () => options.powerSource ?? homeyEnergy(),
);

const renameUpstairs = (name: string, others: readonly SubHomeConfig[] = [GARAGE]): ComposedAreaUpsert => (
  composeAreaUpsert([UPSTAIRS, ...others], { homeId: UPSTAIRS.homeId, name, rootZoneId: 'upstairs', meterDeviceId: 'meter-up' })
);

describe('composeAreaUpsert', () => {
  it('replaces the named area in place without growing the list', () => {
    const upsert = renameUpstairs('First floor');
    expect(upsert.growsList).toBe(false);
    expect(upsert.upserted).toEqual({ ...UPSTAIRS, name: 'First floor' });
    expect(upsert.subHomes).toEqual([{ ...UPSTAIRS, name: 'First floor' }, GARAGE]);
  });

  it('allocates an id for a new area and appends it', () => {
    const upsert = composeAreaUpsert([UPSTAIRS], { name: 'Garage', rootZoneId: 'garage', meterDeviceId: null });
    expect(upsert.growsList).toBe(true);
    expect(upsert.upserted.homeId).toMatch(/^h_/);
    expect(upsert.upserted.homeId).not.toBe(UPSTAIRS.homeId);
    expect(upsert.subHomes).toEqual([UPSTAIRS, upsert.upserted]);
  });

  it('re-adds an area whose id is no longer in the list', () => {
    const upsert = composeAreaUpsert([GARAGE], { homeId: UPSTAIRS.homeId, name: 'Upstairs', rootZoneId: 'upstairs', meterDeviceId: null });
    expect(upsert.growsList).toBe(true);
    expect(upsert.subHomes.map(({ homeId }) => homeId)).toEqual([GARAGE.homeId, UPSTAIRS.homeId]);
  });
});

describe('isAreaRootAtForestRoot', () => {
  const rootedAt = (rootZoneId: string) => ({ name: 'Area', rootZoneId, meterDeviceId: null });

  it('flags an area rooted at a zone with no parent', () => {
    expect(isAreaRootAtForestRoot(rootedAt('house'), ZONES)).toBe(true);
  });

  it('accepts an area rooted below the forest root, an unknown zone, or any zone with no tree yet', () => {
    expect(isAreaRootAtForestRoot(rootedAt('upstairs'), ZONES)).toBe(false);
    expect(isAreaRootAtForestRoot(rootedAt('nowhere'), ZONES)).toBe(false);
    expect(isAreaRootAtForestRoot(rootedAt('house'), null)).toBe(false);
  });
});

describe('findAreaUpsertRefusal — meter ownership', () => {
  it('accepts a savable rename', () => {
    expect(refusalFor(renameUpstairs('First floor'))).toBeNull();
  });

  it('refuses two areas on one meter', () => {
    const upsert = composeAreaUpsert([UPSTAIRS], { name: 'Garage', rootZoneId: 'garage', meterDeviceId: 'meter-up' });
    expect(refusalFor(upsert)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an area on Main’s own meter', () => {
    expect(refusalFor(renameUpstairs('Upstairs'), { mainMeter: 'meter-up' })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('asks for Main’s meter while none is persisted', () => {
    expect(refusalFor(renameUpstairs('Upstairs'), { mainMeter: null }))
      .toEqual({ ok: false, reason: 'main_meter_required' });
  });

  it('refuses on the Flow source before asking for Main’s meter', () => {
    expect(refusalFor(renameUpstairs('Upstairs'), {
      mainMeter: null,
      powerSource: { state: 'resolved', value: 'flow' },
    })).toEqual({ ok: false, reason: 'homey_energy_required' });
  });

  it('refuses as degraded on a suspect power-source read', () => {
    expect(refusalFor(renameUpstairs('Upstairs'), {
      powerSource: { state: 'suspect', reason: 'missing_existing_key', error: new Error('suspect') },
    })).toEqual({ ok: false, reason: 'degraded' });
  });

  it('reads the power source only once the areas own distinct meters', () => {
    const readPowerSource = vi.fn(homeyEnergy);
    const upsert = composeAreaUpsert([UPSTAIRS], { name: 'Garage', rootZoneId: 'garage', meterDeviceId: 'meter-up' });
    findAreaUpsertRefusal(upsert, ZONES, settingsWithMainMeter('meter-main'), readPowerSource);
    expect(readPowerSource).not.toHaveBeenCalled();
  });

  it('answers a meter refusal ahead of a name refusal', () => {
    expect(refusalFor(renameUpstairs('Garage'), { mainMeter: null }))
      .toEqual({ ok: false, reason: 'main_meter_required' });
  });
});

describe('findAreaUpsertRefusal — area count', () => {
  const fullList = Array.from({ length: HOME_AREA_MAX_COUNT }, (_, index) => (
    area(`h_area000${index}`, `Area ${index}`, 'loft', null)
  ));

  it('refuses an area past the cap', () => {
    const upsert = composeAreaUpsert(fullList, { name: 'One more', rootZoneId: 'garage', meterDeviceId: null });
    expect(refusalFor(upsert, { zoneTree: null }))
      .toEqual({ ok: false, reason: 'area_limit_reached', maxCount: HOME_AREA_MAX_COUNT });
  });

  it('still lets an area already over the cap be edited', () => {
    const overCap = [...fullList, area('h_extra000', 'Extra', 'garage', null)];
    const upsert = composeAreaUpsert(overCap, { homeId: 'h_extra000', name: 'Renamed', rootZoneId: 'garage', meterDeviceId: null });
    expect(refusalFor(upsert, { zoneTree: null })).toBeNull();
  });
});

describe('findAreaUpsertRefusal — names', () => {
  it('refuses a name another area already has', () => {
    expect(refusalFor(renameUpstairs('garage'))).toEqual({ ok: false, reason: 'name_duplicate', otherName: 'Garage' });
  });

  it('judges only the area being written, not a duplicate between two others', () => {
    const twins = [area('h_twin_a00', 'Twin', 'loft', null), area('h_twin_b00', 'Twin', 'garage', null)];
    expect(refusalFor(renameUpstairs('First floor', twins), { zoneTree: null })).toBeNull();
  });
});

describe('findAreaUpsertRefusal — root disjointness', () => {
  const LOFT = area('h_loft0000', 'Loft', 'loft', 'meter-loft');

  it('refuses an area nested in another area', () => {
    const upsert = composeAreaUpsert([UPSTAIRS], { name: 'Loft', rootZoneId: 'loft', meterDeviceId: 'meter-loft' });
    expect(refusalFor(upsert)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an edit to either area of an overlapping pair', () => {
    const upsert = composeAreaUpsert([UPSTAIRS, LOFT, GARAGE], { ...LOFT, name: 'Attic' });
    expect(refusalFor(upsert)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('lets an area outside an overlapping pair be edited', () => {
    const upsert = composeAreaUpsert([UPSTAIRS, LOFT, GARAGE], { ...GARAGE, name: 'Workshop' });
    expect(refusalFor(upsert)).toBeNull();
  });

  it('skips the overlap check while no zone tree is known', () => {
    const upsert = composeAreaUpsert([UPSTAIRS], { name: 'Loft', rootZoneId: 'loft', meterDeviceId: 'meter-loft' });
    expect(refusalFor(upsert, { zoneTree: null })).toBeNull();
  });
});

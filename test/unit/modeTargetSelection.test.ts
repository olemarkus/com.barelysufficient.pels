// Which mode a Flow's temperature edit lands in: only modes the device's catalog
// keeps a target record for, following aliases so a Flow built before a rename
// still finds its mode.
import { describe, expect, it } from 'vitest';
import { listTargetModes, resolveTargetMode } from '../../lib/home/modeDeviceTargetWrite';
import type { DeviceModeCatalogOutcome } from '../../lib/home/homeModeDeviceRead';
import type { HomeModeCatalogSnapshot } from '../../lib/home/homeModeCatalog';
import { partialDouble } from '../helpers/partialDouble';

const catalogWith = (
  activeMode: string | null,
  snapshot: Pick<HomeModeCatalogSnapshot, 'targets' | 'aliases' | 'priorities'>,
): Extract<DeviceModeCatalogOutcome, { state: 'resolved' }> => ({
  state: 'resolved',
  catalogHomeId: 'main',
  activeMode,
  catalog: partialDouble<HomeModeCatalogSnapshot>(snapshot),
});

const CATALOG = catalogWith('Home', {
  targets: { Home: { heater: 21 }, Away: { heater: 16 }, Night: {} },
  aliases: { holiday: 'Away' },
  priorities: { Home: { heater: 1 }, Guests: { heater: 2 } },
});

describe('listTargetModes', () => {
  it('lists the modes with a target record, sorted, and not a priorities-only mode', () => {
    expect(listTargetModes(CATALOG)).toEqual(['Away', 'Home', 'Night']);
  });
});

describe('resolveTargetMode', () => {
  it('resolves the active mode', () => {
    expect(resolveTargetMode(CATALOG, { kind: 'active' })).toBe('Home');
  });

  it('resolves a named mode, including through an alias', () => {
    expect(resolveTargetMode(CATALOG, { kind: 'named', name: 'Night' })).toBe('Night');
    expect(resolveTargetMode(CATALOG, { kind: 'named', name: 'Holiday' })).toBe('Away');
  });

  it('answers null for a mode the catalog has no target record for', () => {
    expect(resolveTargetMode(CATALOG, { kind: 'named', name: 'Guests' })).toBeNull();
    expect(resolveTargetMode(CATALOG, { kind: 'named', name: 'Cabin' })).toBeNull();
  });

  it('answers null for the active mode when the device has none', () => {
    expect(resolveTargetMode(catalogWith(null, CATALOG.catalog), { kind: 'active' })).toBeNull();
  });
});

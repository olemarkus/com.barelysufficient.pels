import {
  countDevicesInZoneSubtree,
  findSubHomeRootOverlaps,
  flattenZoneTreeForPicker,
  isZoneInSubtree,
  previewAreaDeviceCount,
  shouldPromptMainHomeMeter,
  suggestSubHomeRootZone,
  validateSubHomeDraft,
  zoneAncestryPath,
  type HomesZoneTree,
  type SubHomeListEntry,
} from '../../shared-domain/src/homesManagement';
import {
  composeDraftErrorLine,
  composeDraftWarningLine,
  composeSubHomeSupportingLine,
  formatZoneDeviceCount,
} from '../../shared-domain/src/homesManagementCopy';

// SHS-shaped zone fixture:
//
//   home (root)
//   ├── Main floor
//   │   ├── Kitchen
//   │   └── Living room
//   ├── Utleie            (rental part — a meter area candidate)
//   │   ├── Stue
//   │   └── Bod           (leaf utility room)
//   └── Anneks            (annex part — a meter area candidate)
//       └── Teknisk rom   (leaf utility room)
const zones: HomesZoneTree = {
  home: { id: 'home', name: 'Home', parent: null },
  main_floor: { id: 'main_floor', name: 'Main floor', parent: 'home' },
  kitchen: { id: 'kitchen', name: 'Kitchen', parent: 'main_floor' },
  living: { id: 'living', name: 'Living room', parent: 'main_floor' },
  utleie: { id: 'utleie', name: 'Utleie', parent: 'home' },
  stue: { id: 'stue', name: 'Stue', parent: 'utleie' },
  bod: { id: 'bod', name: 'Bod', parent: 'utleie' },
  anneks: { id: 'anneks', name: 'Anneks', parent: 'home' },
  teknisk: { id: 'teknisk', name: 'Teknisk rom', parent: 'anneks' },
};

const rentalHome: SubHomeListEntry = {
  homeId: 'h_11111111', name: 'Utleie', rootZoneId: 'utleie', meterDeviceId: 'meter-rental',
};

describe('zoneAncestryPath', () => {
  it('walks leaf-first to the root', () => {
    expect(zoneAncestryPath(zones, 'bod')).toEqual(['bod', 'utleie', 'home']);
  });

  it('fails safe on an unknown zone and on a parent cycle', () => {
    expect(zoneAncestryPath(zones, 'nope')).toBeNull();
    const cyclic: HomesZoneTree = {
      a: { id: 'a', name: 'A', parent: 'b' },
      b: { id: 'b', name: 'B', parent: 'a' },
    };
    expect(zoneAncestryPath(cyclic, 'a')).toBeNull();
  });
});

describe('suggestSubHomeRootZone', () => {
  it('suggests the meter zone itself when the meter sits at the area root (layout A, first area)', () => {
    expect(suggestSubHomeRootZone(zones, 'utleie', [])).toBe('utleie');
  });

  it('walks up from a leaf utility room to the area root (layout B, first area)', () => {
    expect(suggestSubHomeRootZone(zones, 'bod', [])).toBe('utleie');
  });

  it('never suggests the whole-home root zone', () => {
    // A meter placed directly in the root zone has no strict-part ancestor.
    expect(suggestSubHomeRootZone(zones, 'home', [])).toBeNull();
  });

  it('stops below an ancestor containing another area meter (layout B, second area)', () => {
    // Rental meter in Bod, rental root Utleie reserved; annex meter in Teknisk rom.
    expect(suggestSubHomeRootZone(zones, 'teknisk', ['bod', 'utleie'])).toBe('anneks');
  });

  it('stops below an ancestor containing another area meter (layout A, second area)', () => {
    // Rental meter sits at its root zone Utleie; annex meter at its root Anneks.
    expect(suggestSubHomeRootZone(zones, 'anneks', ['utleie', 'utleie'])).toBe('anneks');
  });

  it('returns null when the meter shares a zone with a reserved meter', () => {
    expect(suggestSubHomeRootZone(zones, 'bod', ['bod'])).toBeNull();
  });

  it('never suggests a zone nested inside another configured area', () => {
    // Meter in Stue while Utleie is already another area's root: every
    // candidate is either inside Utleie or contains it.
    expect(suggestSubHomeRootZone(zones, 'stue', ['utleie'])).toBeNull();
  });

  it('fails safe on a broken meter-zone chain', () => {
    const broken: HomesZoneTree = {
      orphan: { id: 'orphan', name: 'Orphan', parent: 'missing' },
    };
    expect(suggestSubHomeRootZone(broken, 'orphan', [])).toBeNull();
  });

  it('ignores reserved entries whose own zone chain is broken', () => {
    expect(suggestSubHomeRootZone(zones, 'bod', ['not-a-zone'])).toBe('utleie');
  });
});

describe('findSubHomeRootOverlaps', () => {
  it('reports nothing for disjoint roots', () => {
    expect(findSubHomeRootOverlaps(
      [{ homeId: 'a', rootZoneId: 'utleie' }, { homeId: 'b', rootZoneId: 'anneks' }],
      zones,
    )).toEqual([]);
  });

  it('flags a root nested inside another root subtree', () => {
    expect(findSubHomeRootOverlaps(
      [{ homeId: 'a', rootZoneId: 'utleie' }, { homeId: 'b', rootZoneId: 'stue' }],
      zones,
    )).toEqual([{ outerHomeId: 'a', innerHomeId: 'b' }]);
  });

  it('flags identical roots exactly once', () => {
    expect(findSubHomeRootOverlaps(
      [{ homeId: 'a', rootZoneId: 'utleie' }, { homeId: 'b', rootZoneId: 'utleie' }],
      zones,
    )).toEqual([{ outerHomeId: 'a', innerHomeId: 'b' }]);
  });

  it('never flags on broken zone data', () => {
    expect(findSubHomeRootOverlaps(
      [{ homeId: 'a', rootZoneId: 'ghost' }, { homeId: 'b', rootZoneId: 'utleie' }],
      zones,
    )).toEqual([]);
  });
});

describe('isZoneInSubtree', () => {
  it('resolves containment and returns null on broken chains', () => {
    expect(isZoneInSubtree(zones, 'bod', 'utleie')).toBe(true);
    expect(isZoneInSubtree(zones, 'kitchen', 'utleie')).toBe(false);
    expect(isZoneInSubtree(zones, 'ghost', 'utleie')).toBeNull();
  });
});

describe('previewAreaDeviceCount', () => {
  const membershipByDeviceId = {
    // Zone-rule devices across the fixture tree.
    heater_stue: { homeId: 'h_11111111', source: 'zone' as const },
    heater_kitchen: { homeId: 'main', source: 'zone' as const },
    // Pinned OUT of the rental area (must never count for it)…
    pinned_out: { homeId: 'main', source: 'pin' as const },
    // …and pinned INTO it (counts only when EDITING that area).
    pinned_in: { homeId: 'h_11111111', source: 'pin' as const },
    // Fallback-resolved device with no known zone.
    lost: { homeId: 'main', source: 'fallback' as const },
  };
  const zoneIdByDeviceId = new Map<string, string | null>([
    ['heater_stue', 'stue'],
    ['heater_kitchen', 'kitchen'],
    ['pinned_out', 'bod'],
    ['pinned_in', 'kitchen'],
    ['lost', null],
  ]);

  it('honors pins over the zone rule, like the runtime resolver', () => {
    // Creating a new area over Utleie: the zone-rule device in Stue counts;
    // the device pinned out (despite sitting in Bod) does not; the device
    // pinned into the EXISTING rental area does not count for a NEW area.
    expect(previewAreaDeviceCount({
      zones, rootZoneId: 'utleie', membershipByDeviceId, zoneIdByDeviceId, areaHomeId: null,
    })).toBe(1);
    // Editing the rental area itself: its pinned-in device joins the count.
    expect(previewAreaDeviceCount({
      zones, rootZoneId: 'utleie', membershipByDeviceId, zoneIdByDeviceId, areaHomeId: 'h_11111111',
    })).toBe(2);
  });
});

describe('validateSubHomeDraft', () => {
  const validDraft = {
    homeId: null,
    name: 'Anneks',
    meterDeviceId: 'meter-annex',
    rootZoneId: 'anneks',
  };

  it('accepts a clean draft', () => {
    const result = validateSubHomeDraft({
      draft: validDraft, existing: [rentalHome], zones, meterZoneId: 'teknisk',
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it('requires a name, a meter, and a zone', () => {
    const result = validateSubHomeDraft({
      draft: { homeId: null, name: '  ', meterDeviceId: null, rootZoneId: null },
      existing: [],
      zones,
      meterZoneId: null,
    });
    expect(result.errors.map((error) => error.kind))
      .toEqual(['name_missing', 'meter_missing', 'zone_missing']);
  });

  it('flags a duplicate name case-insensitively, naming the clash', () => {
    const result = validateSubHomeDraft({
      draft: { ...validDraft, name: ' utleie ' }, existing: [rentalHome], zones, meterZoneId: null,
    });
    expect(result.errors).toContainEqual({ kind: 'name_duplicate', otherName: 'Utleie' });
  });

  it('flags a meter already metering another area', () => {
    const result = validateSubHomeDraft({
      draft: { ...validDraft, meterDeviceId: 'meter-rental' },
      existing: [rentalHome],
      zones,
      meterZoneId: null,
    });
    expect(result.errors).toContainEqual({ kind: 'meter_in_use', otherName: 'Utleie' });
  });

  it('flags a root zone overlapping another area (either direction)', () => {
    const nested = validateSubHomeDraft({
      draft: { ...validDraft, rootZoneId: 'stue' }, existing: [rentalHome], zones, meterZoneId: null,
    });
    expect(nested.errors).toContainEqual({ kind: 'zone_overlap', otherName: 'Utleie' });
    // Containing direction needs a NON-root container (the root itself is
    // rejected as zone_is_root before overlap checks run): home → wing → utleie.
    const wingZones: HomesZoneTree = {
      home: { id: 'home', name: 'Home', parent: null },
      wing: { id: 'wing', name: 'Wing', parent: 'home' },
      utleie: { id: 'utleie', name: 'Utleie', parent: 'wing' },
    };
    const containing = validateSubHomeDraft({
      draft: { ...validDraft, rootZoneId: 'wing' }, existing: [rentalHome], zones: wingZones, meterZoneId: null,
    });
    expect(containing.errors).toContainEqual({ kind: 'zone_overlap', otherName: 'Utleie' });
  });

  it('rejects a zone-forest root as an area root (strict-subpart invariant)', () => {
    const result = validateSubHomeDraft({
      draft: { ...validDraft, rootZoneId: 'home' }, existing: [], zones, meterZoneId: null,
    });
    expect(result.errors).toContainEqual({ kind: 'zone_is_root' });
  });

  it('warns — without blocking — when the meter sits outside the chosen zone', () => {
    const result = validateSubHomeDraft({
      draft: validDraft, existing: [], zones, meterZoneId: 'kitchen',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([{ kind: 'meter_outside_zone' }]);
  });

  it('does not warn when the meter zone chain is broken', () => {
    const result = validateSubHomeDraft({
      draft: validDraft, existing: [], zones, meterZoneId: 'ghost',
    });
    expect(result.warnings).toEqual([]);
  });

  it('excludes the edited area itself from clash checks', () => {
    const result = validateSubHomeDraft({
      draft: {
        homeId: rentalHome.homeId,
        name: rentalHome.name,
        meterDeviceId: rentalHome.meterDeviceId,
        rootZoneId: rentalHome.rootZoneId,
      },
      existing: [rentalHome],
      zones,
      meterZoneId: 'bod',
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });
});

describe('countDevicesInZoneSubtree', () => {
  it('counts device zones inside the subtree, root included, skipping unknowns', () => {
    const deviceZones = ['bod', 'stue', 'kitchen', 'utleie', null, 'ghost'];
    expect(countDevicesInZoneSubtree(zones, 'utleie', deviceZones)).toBe(3);
    expect(countDevicesInZoneSubtree(zones, 'main_floor', deviceZones)).toBe(1);
    expect(countDevicesInZoneSubtree(zones, 'anneks', deviceZones)).toBe(0);
  });
});

describe('shouldPromptMainHomeMeter', () => {
  it('prompts exactly when areas exist on Homey Energy without an explicit whole-home meter', () => {
    const base = { subHomeCount: 1, powerSource: 'homey_energy', mainMeterDeviceId: null };
    expect(shouldPromptMainHomeMeter(base)).toBe(true);
    expect(shouldPromptMainHomeMeter({ ...base, subHomeCount: 0 })).toBe(false);
    expect(shouldPromptMainHomeMeter({ ...base, powerSource: 'flow' })).toBe(false);
    expect(shouldPromptMainHomeMeter({ ...base, powerSource: null })).toBe(false);
    expect(shouldPromptMainHomeMeter({ ...base, mainMeterDeviceId: 'dev_meter' })).toBe(false);
  });
});

describe('flattenZoneTreeForPicker', () => {
  it('lists depth-first with name-sorted siblings and depths', () => {
    const options = flattenZoneTreeForPicker(zones);
    expect(options.map((option) => `${option.depth}:${option.name}`)).toEqual([
      '0:Home',
      '1:Anneks',
      '2:Teknisk rom',
      '1:Main floor',
      '2:Kitchen',
      '2:Living room',
      '1:Utleie',
      '2:Bod',
      '2:Stue',
    ]);
  });

  it('lists orphans as roots so damaged zone data stays pickable', () => {
    const damaged: HomesZoneTree = {
      orphan: { id: 'orphan', name: 'Orphan', parent: 'gone' },
    };
    expect(flattenZoneTreeForPicker(damaged)).toEqual([{ id: 'orphan', name: 'Orphan', depth: 0 }]);
  });
});

describe('homesManagementCopy', () => {
  it('composes the list supporting line with fallbacks', () => {
    expect(composeSubHomeSupportingLine({ meterName: 'Måler utleie', zoneName: 'Utleie', deviceCount: 3 }))
      .toBe('Måler utleie · Utleie · 3 devices');
    expect(composeSubHomeSupportingLine({ meterName: null, zoneName: null, deviceCount: 1 }))
      .toBe('Meter not found · Zone not found · 1 device');
  });

  it('names the clashing area in validation lines', () => {
    expect(composeDraftErrorLine({ kind: 'zone_overlap', otherName: 'Utleie' }))
      .toBe('This zone overlaps “Utleie”. Pick a zone outside it.');
    expect(composeDraftErrorLine({ kind: 'zone_is_root' }))
      .toBe('This zone covers the whole home. Pick just the part this meter measures.');
    expect(composeDraftWarningLine({ kind: 'meter_outside_zone' })).toContain('You can still save');
  });

  it('marks the fresh-boot preview estimate as approximate', () => {
    expect(formatZoneDeviceCount(3)).toBe('3 devices in this zone and its sub-zones');
    expect(formatZoneDeviceCount(1, true)).toBe('About 1 device in this zone and its sub-zones');
    expect(formatZoneDeviceCount(0, true)).toBe('No devices in this zone and its sub-zones');
  });
});

import { describe, expect, it } from 'vitest';
import { isSimulationBannerSuppressedOnPanel } from '../src/ui/capacity.ts';
import {
  mergeMeterAreaSimulation,
  readHomesConfigScope,
  resolveActiveMeterAreas,
  resolveHasMeterAreas,
  resolveRetainedScopeClaim,
} from '../src/ui/meterAreaPosture.ts';
import {
  resolveSimulationBannerContent,
  resolveSimulationPosture,
} from '../../shared-domain/src/simulationPosture.ts';
import { resolveSimulationChipLabel } from '../../shared-domain/src/settingsHubChips.ts';

describe('simulation posture resolution', () => {
  it('is all_simulating only when Main and every area simulate', () => {
    expect(resolveSimulationPosture({ mainSimulating: true, areaSimulating: [] }))
      .toBe('all_simulating');
    expect(resolveSimulationPosture({ mainSimulating: true, areaSimulating: [true, true] }))
      .toBe('all_simulating');
  });

  it('is all_live only when Main and every area are live', () => {
    expect(resolveSimulationPosture({ mainSimulating: false, areaSimulating: [] }))
      .toBe('all_live');
    expect(resolveSimulationPosture({ mainSimulating: false, areaSimulating: [false] }))
      .toBe('all_live');
  });

  it('is mixed for every split, in both directions', () => {
    expect(resolveSimulationPosture({ mainSimulating: true, areaSimulating: [false] }))
      .toBe('mixed');
    expect(resolveSimulationPosture({ mainSimulating: false, areaSimulating: [true] }))
      .toBe('mixed');
    expect(resolveSimulationPosture({ mainSimulating: true, areaSimulating: [true, false] }))
      .toBe('mixed');
  });

  it('blocks both absolute claims while any area flag is unknown', () => {
    // An unknown (null) area is one nobody can vouch for: `all_live` would
    // silence the chip while it may simulate, `all_simulating` would
    // overclaim `On` while it may be live. The aggregate degrades to the
    // cautious `mixed` until every active area has a resolved flag.
    expect(resolveSimulationPosture({ mainSimulating: true, areaSimulating: [null] }))
      .toBe('mixed');
    expect(resolveSimulationPosture({ mainSimulating: false, areaSimulating: [null] }))
      .toBe('mixed');
    expect(resolveSimulationPosture({ mainSimulating: true, areaSimulating: [true, null] }))
      .toBe('mixed');
    expect(resolveSimulationPosture({ mainSimulating: false, areaSimulating: [false, null] }))
      .toBe('mixed');
    expect(resolveSimulationPosture({ mainSimulating: false, areaSimulating: [true, null] }))
      .toBe('mixed');
  });
});

describe('posture snapshot merge (last-good across bad reads)', () => {
  const rental = { homeId: 'h_rental', name: 'Rental unit' };
  const cabin = { homeId: 'h_cabin', name: 'Cabin' };
  const resolved = (simulating: boolean) => ({ status: 'resolved' as const, simulating });
  const absent = { status: 'absent' as const, runtimeSimulating: null };
  const unavailable = { status: 'unavailable' as const, runtimeSimulating: null };

  it('adopts resolved flags and drops areas no longer in the roster', () => {
    expect(mergeMeterAreaSimulation([rental], [resolved(false)], [
      { homeId: 'h_cabin', name: 'Cabin', simulating: true },
    ])).toEqual([
      { homeId: 'h_rental', name: 'Rental unit', simulating: false },
    ]);
  });

  it('keeps the area\'s last resolved value when its flag read fails', () => {
    // Main live + a simulating area: one bad read must not flip the posture
    // to all-live (and the mirror-image split must not overclaim `On`).
    expect(mergeMeterAreaSimulation([rental, cabin], [unavailable, resolved(false)], [
      { homeId: 'h_rental', name: 'Rental unit', simulating: true },
      { homeId: 'h_cabin', name: 'Cabin', simulating: false },
    ])).toEqual([
      { homeId: 'h_rental', name: 'Rental unit', simulating: true },
      { homeId: 'h_cabin', name: 'Cabin', simulating: false },
    ]);
  });

  it('keeps the last resolved value when the flag is unset', () => {
    // The runtime adapter resolves absence to its last-good `dryRun`
    // (`setup/capacitySettingsStoreAdapter.ts`) — an already-live area whose
    // suffixed flag is unset stays live in the runtime, so the UI must not
    // repaint it with the boot default and announce a phantom simulation.
    expect(mergeMeterAreaSimulation([rental, cabin], [absent, absent], [
      { homeId: 'h_rental', name: 'Rental unit', simulating: false },
      { homeId: 'h_cabin', name: 'Cabin', simulating: true },
    ])).toEqual([
      { homeId: 'h_rental', name: 'Rental unit', simulating: false },
      { homeId: 'h_cabin', name: 'Cabin', simulating: true },
    ]);
  });

  it('matches last-good by homeId so a rename keeps its value', () => {
    expect(mergeMeterAreaSimulation(
      [{ homeId: 'h_rental', name: 'Guest wing' }],
      [unavailable],
      [{ homeId: 'h_rental', name: 'Rental unit', simulating: true }],
    )).toEqual([{ homeId: 'h_rental', name: 'Guest wing', simulating: true }]);
  });

  it('resolves an unset flag with no history to the simulating boot default', () => {
    // Absent-with-no-history is a fresh area: never written = the runtime's
    // dry-run-TRUE boot default (only here — with history, last-good wins).
    expect(mergeMeterAreaSimulation([rental], [absent], []))
      .toEqual([{ homeId: 'h_rental', name: 'Rental unit', simulating: true }]);
    // A still-unknown previous value is no history either.
    expect(mergeMeterAreaSimulation([rental], [absent], [
      { homeId: 'h_rental', name: 'Rental unit', simulating: null },
    ])).toEqual([{ homeId: 'h_rental', name: 'Rental unit', simulating: true }]);
  });

  it('asks the runtime what it is doing before falling back to the boot default', () => {
    // The bundle outlives the WebView: a reload has no history for an area
    // whose flag was unset while it was LIVE, and the boot default would
    // announce a simulation the still-running bundle is not doing.
    expect(mergeMeterAreaSimulation(
      [rental],
      [{ status: 'absent', runtimeSimulating: false }],
      [],
    )).toEqual([{ homeId: 'h_rental', name: 'Rental unit', simulating: false }]);
    // Same for a malformed flag, which would otherwise carry an unknown.
    expect(mergeMeterAreaSimulation(
      [rental],
      [{ status: 'unavailable', runtimeSimulating: true }],
      [],
    )).toEqual([{ homeId: 'h_rental', name: 'Rental unit', simulating: true }]);
  });

  it('still prefers this session\'s last resolved value over the runtime posture', () => {
    // The status blob is written per plan, so it can lag a flag the UI itself
    // resolved this session; history stays the first answer.
    expect(mergeMeterAreaSimulation(
      [rental],
      [{ status: 'absent', runtimeSimulating: true }],
      [{ homeId: 'h_rental', name: 'Rental unit', simulating: false }],
    )).toEqual([{ homeId: 'h_rental', name: 'Rental unit', simulating: false }]);
  });

  it('carries an explicit unknown when nothing last-good exists', () => {
    expect(mergeMeterAreaSimulation([rental], [unavailable], []))
      .toEqual([{ homeId: 'h_rental', name: 'Rental unit', simulating: null }]);
    // A still-unresolved area stays unknown rather than inventing a flag.
    expect(mergeMeterAreaSimulation([rental], [unavailable], [
      { homeId: 'h_rental', name: 'Rental unit', simulating: null },
    ])).toEqual([{ homeId: 'h_rental', name: 'Rental unit', simulating: null }]);
  });
});

describe('simulation banner suppression on the Simulation-mode page', () => {
  it('suppresses only the banners whose remedy the page\'s Main switch duplicates', () => {
    expect(isSimulationBannerSuppressedOnPanel('all', 'simulation')).toBe(true);
    expect(isSimulationBannerSuppressedOnPanel('main', 'simulation')).toBe(true);
    // The area-naming line stays: the page's Main switch is OFF in that
    // posture, so hiding it would render an apparently all-live screen at the
    // end of the "Partly on" chip's trail.
    expect(isSimulationBannerSuppressedOnPanel('areas', 'simulation')).toBe(false);
  });

  it('never suppresses on any other panel', () => {
    for (const scope of ['all', 'main', 'areas'] as const) {
      expect(isSimulationBannerSuppressedOnPanel(scope, 'overview')).toBe(false);
    }
  });
});

describe('settings hub simulation chip', () => {
  it('stays silent while everything is live and names each other posture', () => {
    expect(resolveSimulationChipLabel('all_live')).toBeNull();
    expect(resolveSimulationChipLabel('all_simulating')).toBe('On');
    expect(resolveSimulationChipLabel('mixed')).toBe('Partly on');
  });
});

describe('simulation banner content', () => {
  it('keeps the single-home copy when no meter areas exist', () => {
    expect(resolveSimulationBannerContent({
      hasMeterAreas: false,
      mainSimulating: true,
      simulatingAreaNames: [],
    })).toEqual({
      text: 'Simulation on — devices stay as-is',
      actionLabel: 'Turn off simulation',
      scope: 'all',
    });
  });

  it('hides with no meter areas while Main is live', () => {
    expect(resolveSimulationBannerContent({
      hasMeterAreas: false,
      mainSimulating: false,
      simulatingAreaNames: [],
    })).toBeNull();
  });

  it('scopes both claims to Main when a meter area exists and Main simulates', () => {
    // Regardless of whether the areas simulate too: the Main claim is the one
    // the button acts on, and it never overclaims about the areas.
    for (const simulatingAreaNames of [[], ['Rental unit']]) {
      expect(resolveSimulationBannerContent({
        hasMeterAreas: true,
        mainSimulating: true,
        simulatingAreaNames,
      })).toEqual({
        text: 'Main home simulation on — Main home devices stay as-is',
        actionLabel: 'Turn off Main home simulation',
        scope: 'main',
      });
    }
  });

  it('keeps the conservative Main-scoped copy when the roster is unclassifiable', () => {
    expect(resolveSimulationBannerContent({
      hasMeterAreas: null,
      mainSimulating: true,
      simulatingAreaNames: [],
    })).toEqual({
      text: 'Main home simulation on — Main home devices stay as-is',
      actionLabel: 'Turn off Main home simulation',
      scope: 'main',
    });
  });

  it('names the one simulating area while Main is live, with no Main-flag button', () => {
    expect(resolveSimulationBannerContent({
      hasMeterAreas: true,
      mainSimulating: false,
      simulatingAreaNames: ['Rental unit'],
    })).toEqual({
      text: 'PELS is only simulating “Rental unit”. Turn on control under Limits & safety.',
      actionLabel: null,
      scope: 'areas',
    });
  });

  it('resolves a blank persisted area name through the shared display rule', () => {
    expect(resolveSimulationBannerContent({
      hasMeterAreas: true,
      mainSimulating: false,
      simulatingAreaNames: ['   '],
    })?.text).toBe('PELS is only simulating “Meter area”. Turn on control under Limits & safety.');
  });

  it('counts multiple simulating areas while Main is live', () => {
    expect(resolveSimulationBannerContent({
      hasMeterAreas: true,
      mainSimulating: false,
      simulatingAreaNames: ['Rental unit', 'Cabin'],
    })).toEqual({
      text: 'PELS is only simulating 2 meter areas. Turn on control under Limits & safety.',
      actionLabel: null,
      scope: 'areas',
    });
  });

  it('hides when Main and every area are live', () => {
    expect(resolveSimulationBannerContent({
      hasMeterAreas: true,
      mainSimulating: false,
      simulatingAreaNames: [],
    })).toBeNull();
  });
});

describe('meter-area roster classification', () => {
  it('preserves the no-areas resolution when the saved roster is empty', () => {
    expect(resolveHasMeterAreas({
      status: 'resolved',
      config: undefined,
      initializedMarker: undefined,
    })).toBe(false);
    expect(resolveHasMeterAreas({
      status: 'resolved',
      config: { subHomes: [] },
      initializedMarker: true,
    })).toBe(false);
  });

  it('resolves an existing area to true and unclassifiable state to null', () => {
    expect(resolveHasMeterAreas({
      status: 'resolved',
      config: { subHomes: [{ homeId: 'h_rental' }] },
      initializedMarker: true,
    })).toBe(true);
    for (const initializedMarker of [true, false, 'invalid']) {
      expect(resolveHasMeterAreas({
        status: 'resolved',
        config: undefined,
        initializedMarker,
      })).toBeNull();
    }
    expect(resolveHasMeterAreas({
      status: 'resolved',
      config: { subHomes: 'invalid' },
      initializedMarker: true,
    })).toBeNull();
    expect(resolveHasMeterAreas({ status: 'unavailable' })).toBeNull();
  });

  it('resolves active areas only from a GA-activated config', () => {
    // Meter absent, meter null, and meter set are all plausible shapes.
    expect(resolveActiveMeterAreas({
      status: 'resolved',
      config: {
        activationVersion: 1,
        subHomes: [
          { homeId: 'h_rental', name: 'Rental unit', rootZoneId: 'z_rental' },
          { homeId: 'h_cabin', name: 'Cabin', rootZoneId: 'z_cabin', meterDeviceId: null },
          { homeId: 'h_annex', name: 'Annex', rootZoneId: 'z_annex', meterDeviceId: 'dev_annex_meter' },
        ],
      },
      initializedMarker: true,
    })).toEqual({
      status: 'resolved',
      areas: [
        { homeId: 'h_rental', name: 'Rental unit' },
        { homeId: 'h_cabin', name: 'Cabin' },
        { homeId: 'h_annex', name: 'Annex' },
      ],
    });
  });

  it('resolves a held pre-GA config, and an absent one, to no active areas', () => {
    // A held config's devices still belong to the Main home, so its flags
    // must never enter the posture; a never-written config has no areas at
    // all. Both are RESOLVED empties — legitimately clearing a snapshot —
    // unlike the suspect reads below.
    expect(resolveActiveMeterAreas({
      status: 'resolved',
      config: { subHomes: [{ homeId: 'h_rental', name: 'Rental unit', rootZoneId: 'z_rental' }] },
      initializedMarker: true,
    })).toEqual({ status: 'resolved', areas: [] });
    expect(resolveActiveMeterAreas({
      status: 'resolved',
      config: undefined,
      initializedMarker: undefined,
    })).toEqual({ status: 'resolved', areas: [] });
  });

  it('classifies the whole roster unavailable when any entry is implausible', () => {
    // Mirrors the runtime's `isPlausibleHomesConfigBlob`: a partially corrupt
    // roster classifies as suspect WHOLESALE, so the intact area must not
    // survive as a quietly smaller roster in the posture — including when
    // the entry is malformed only in a field the posture never displays
    // (missing `rootZoneId`, junk `meterDeviceId`).
    const intact = { homeId: 'h_rental', name: 'Rental unit', rootZoneId: 'z_rental', meterDeviceId: 'dev_rental_meter' };
    const implausibleEntries: unknown[] = [
      { homeId: 'main', name: 'Reserved', rootZoneId: 'z_a' },
      { homeId: 'h_a:b', name: 'Colon', rootZoneId: 'z_a' },
      { homeId: '__proto__', name: 'Dangerous', rootZoneId: 'z_a' },
      { homeId: '', name: 'Empty', rootZoneId: 'z_a' },
      { homeId: 42, name: 'Non-string id', rootZoneId: 'z_a' },
      { homeId: 'h_ok', name: 7, rootZoneId: 'z_a' },
      { homeId: 'h_ok', name: 'No root zone' },
      { homeId: 'h_ok', name: 'Blank root zone', rootZoneId: '' },
      { homeId: 'h_ok', name: 'Non-string root zone', rootZoneId: 42 },
      { homeId: 'h_ok', name: 'Blank meter', rootZoneId: 'z_a', meterDeviceId: '' },
      { homeId: 'h_ok', name: 'Non-string meter', rootZoneId: 'z_a', meterDeviceId: 42 },
      'not-a-record',
      ['not', 'a', 'record'],
      { homeId: 'h_rental', name: 'Duplicate id', rootZoneId: 'z_b' },
      // The runtime's `hasUniqueSubHomeMeters` rule: one live meter routed
      // into two capacity bundles rejects the blob wholesale there, so the
      // mirror must not publish both entries (and their flags) here.
      { homeId: 'h_reuse', name: 'Meter reuse', rootZoneId: 'z_b', meterDeviceId: 'dev_rental_meter' },
    ];
    for (const entry of implausibleEntries) {
      expect(resolveActiveMeterAreas({
        status: 'resolved',
        config: { activationVersion: 1, subHomes: [intact, entry] },
        initializedMarker: true,
      })).toEqual({ status: 'unavailable' });
    }
  });

  it('classifies unavailable or malformed reads unavailable, never resolved-empty', () => {
    // Abandon-grace at the caller depends on this discrimination: a suspect
    // read keeps the last-good snapshot; only a RESOLVED empty clears it.
    expect(resolveActiveMeterAreas({ status: 'unavailable' })).toEqual({ status: 'unavailable' });
    expect(resolveActiveMeterAreas({
      status: 'resolved',
      config: ['not', 'a', 'record'],
      initializedMarker: true,
    })).toEqual({ status: 'unavailable' });
    expect(resolveActiveMeterAreas({
      status: 'resolved',
      config: { activationVersion: 2, subHomes: [{ homeId: 'h_rental', name: 'Rental unit' }] },
      initializedMarker: true,
    })).toEqual({ status: 'unavailable' });
    expect(resolveActiveMeterAreas({
      status: 'resolved',
      config: { activationVersion: 1, subHomes: 'invalid' },
      initializedMarker: true,
    })).toEqual({ status: 'unavailable' });
  });

  it('keeps the last-good scope claim when a suspect roster looks empty', () => {
    // `{ activationVersion: 2, subHomes: [] }` is suspect wholesale, so its
    // empty array must not resolve to the vouched "no meter areas" claim: the
    // banner's no-areas branch would hide the area warning while the retained
    // snapshot still names a simulating area.
    const suspectEmpty: Parameters<typeof resolveRetainedScopeClaim>[1] = {
      status: 'resolved',
      config: { activationVersion: 2, subHomes: [] },
      initializedMarker: true,
    };
    expect(resolveHasMeterAreas(suspectEmpty)).toBe(false);
    expect(resolveActiveMeterAreas(suspectEmpty)).toEqual({ status: 'unavailable' });
    expect(resolveRetainedScopeClaim(true, suspectEmpty)).toBe(true);
    expect(resolveRetainedScopeClaim(null, suspectEmpty)).toBeNull();
    // A single-home install that never had areas keeps its own claim, so the
    // whole-home banner copy survives a suspect blob too.
    expect(resolveRetainedScopeClaim(false, suspectEmpty)).toBe(false);
  });

  it('adopts every scope claim a suspect roster can still support', () => {
    // Only `false` is withheld: `true` and `null` both keep the cautious
    // Main-scoped copy, so adopting them can never overclaim.
    expect(resolveRetainedScopeClaim(false, {
      status: 'resolved',
      config: { activationVersion: 2, subHomes: [{ homeId: 'h_rental' }] },
      initializedMarker: true,
    })).toBe(true);
    expect(resolveRetainedScopeClaim(false, { status: 'unavailable' })).toBeNull();
  });

  it('classifies a thrown roster or marker read as unavailable', async () => {
    await expect(readHomesConfigScope(async () => {
      throw new Error('transient settings read failure');
    })).resolves.toEqual({ status: 'unavailable' });
    await expect(readHomesConfigScope(async (key) => (
      key === 'homes_config' ? { subHomes: [] } : true
    ))).resolves.toEqual({
      status: 'resolved',
      config: { subHomes: [] },
      initializedMarker: true,
    });
  });
});

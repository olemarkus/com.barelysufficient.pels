// Unit coverage for the meter-area config rules and their refusal copy: the
// pure caps and name rules a saved area must satisfy (the save seam in
// `setup/homeMeterOwnership.ts` is what enforces them) and the one actionable
// line each refusal renders.
import { describe, expect, it, vi } from 'vitest';
import {
  findHomeAreaNameRejection,
  normalizeHomeAreaName,
  HOME_AREA_MAX_COUNT,
  HOME_AREA_NAME_MAX_LENGTH,
  RESERVED_HOME_AREA_NAMES,
} from '../../packages/shared-domain/src/homeAreaConfigRules';
import {
  composeHomeAreaSaveRefusalLine,
  composePowerSourceSaveRefusalLine,
  HOMES_AREA_NEEDS_HOMEY_ENERGY,
  HOMES_AREA_NEEDS_MAIN_METER,
  HOMES_MAIN_METER_NEEDED_BY_AREAS,
  HOMES_POWER_SOURCE_NEEDED_BY_AREAS,
  HOMES_POWER_SOURCE_SAVE_FAILED,
} from '../../packages/shared-domain/src/homeAreaConfigRulesCopy';
import { HOMES_MAIN_HOME_NAME } from '../../packages/shared-domain/src/homeNames';

describe('normalizeHomeAreaName', () => {
  it('strips surrounding whitespace and leaves the inside of the name alone', () => {
    expect(normalizeHomeAreaName('  Garage  flat \n')).toBe('Garage  flat');
  });
});

describe('findHomeAreaNameRejection', () => {
  const reject = (name: string, otherNames: readonly string[] = []) => (
    findHomeAreaNameRejection({ name, otherNames })
  );

  it('accepts a name distinct from the other areas', () => {
    expect(reject('Cabin', ['Upstairs', 'Garage flat'])).toBeNull();
  });

  it('rejects a name that is empty once trimmed', () => {
    expect(reject('   ', ['Upstairs'])).toEqual({ reason: 'name_required' });
  });

  it('rejects a name past the length cap and reports the cap', () => {
    expect(reject('a'.repeat(HOME_AREA_NAME_MAX_LENGTH))).toBeNull();
    expect(reject('a'.repeat(HOME_AREA_NAME_MAX_LENGTH + 1))).toEqual({
      reason: 'name_too_long',
      maxLength: HOME_AREA_NAME_MAX_LENGTH,
    });
  });

  it('counts an astral symbol as one character against the cap, as the refusal message promises', () => {
    // '🏠' is two UTF-16 units; a units-based count would refuse this legal name.
    expect(reject('🏠'.repeat(HOME_AREA_NAME_MAX_LENGTH))).toBeNull();
    expect(reject('🏠'.repeat(HOME_AREA_NAME_MAX_LENGTH + 1))).toEqual({
      reason: 'name_too_long',
      maxLength: HOME_AREA_NAME_MAX_LENGTH,
    });
  });

  it('spends the cap on the composed name, so NFC-equivalent spellings share one limit', () => {
    // Escapes, not raw literals: an editor renormalizing this file would merge
    // the two forms and silence the test.
    const composedAcute = '\u00e9'; // e-acute precomposed: 1 code point
    const decomposedAcute = 'e\u0301'; // e + combining acute: 2 code points, same name
    // Counting before composing would refuse this at 80 while its canonically
    // equivalent (and duplicate-identical) composed spelling saves at 40.
    expect(reject(decomposedAcute.repeat(HOME_AREA_NAME_MAX_LENGTH))).toBeNull();
    expect(reject(composedAcute.repeat(HOME_AREA_NAME_MAX_LENGTH))).toBeNull();
    // Both spellings hit the cap at the same length, too.
    expect(reject(decomposedAcute.repeat(HOME_AREA_NAME_MAX_LENGTH + 1))).toEqual({
      reason: 'name_too_long',
      maxLength: HOME_AREA_NAME_MAX_LENGTH,
    });
  });

  it('reserves the Main home name case-insensitively and reports the canonical spelling', () => {
    expect(reject(' MAIN home ')).toEqual({ reason: 'name_reserved', reservedName: 'Main home' });
    expect(RESERVED_HOME_AREA_NAMES).toContain('Main home');
  });

  it('reserves whatever the switcher calls the Main home, not a second spelling', () => {
    // Renaming the option must rename what is reserved; a literal here would
    // silently keep reserving the old spelling.
    expect(RESERVED_HOME_AREA_NAMES).toEqual([HOMES_MAIN_HOME_NAME]);
  });

  it('rejects a duplicate name case-insensitively and names the area it clashes with', () => {
    expect(reject('garage FLAT', ['Upstairs', ' Garage flat '])).toEqual({
      reason: 'name_duplicate',
      otherName: 'Garage flat',
    });
  });

  it('rejects a decomposed duplicate of a composed name (NFC and NFD render identically)', () => {
    // Same visible name "Caf\u00e9", different code points. Escapes, not raw
    // literals: an editor renormalizing this file must not merge the forms.
    const composedCafe = 'Caf\u00e9'; // e-acute precomposed
    const decomposedCafe = 'Cafe\u0301'; // e + combining acute
    // Folding raw code points would let both spellings save.
    expect(reject(decomposedCafe, [composedCafe])).toEqual({
      reason: 'name_duplicate',
      otherName: composedCafe,
    });
    // The same collision the other way round; the reported clash keeps the
    // other area's stored (decomposed) form, because folding is comparison-only.
    expect(reject(composedCafe, [decomposedCafe])).toEqual({
      reason: 'name_duplicate',
      otherName: decomposedCafe,
    });
    // Visibly distinct accented names still pass: NFC folding only merges
    // code-point spellings of the SAME rendered name.
    expect(reject(decomposedCafe, ['Cabin'])).toBeNull();
  });

  it('reserves an accented Main home label against its decomposed lookalike', async () => {
    // The reserved list is sourced from the switcher's label, which is plain
    // ASCII today, so the real constant cannot exercise this. Pin an accented
    // label to prove the reserved comparison folds through NFC exactly like
    // the duplicate check: a-ring precomposed (\u00e5) vs A + combining ring.
    vi.resetModules();
    // Partial mocks of BOTH candidate sources: the reserved list reads the
    // canonical Main-home label, whose home module moved during the train
    // (homeLimitsCopy's switcher alias retired; the name itself now lives in
    // the dependency-neutral homeNames leaf). Spreading the originals keeps
    // every other export intact either way.
    vi.doMock('../../packages/shared-domain/src/homeLimitsCopy', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      HOME_LIMITS_MAIN_HOME_OPTION: 'Hovedm\u00e5ler',
    }));
    vi.doMock('../../packages/shared-domain/src/homeNames', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      HOMES_MAIN_HOME_NAME: 'Hovedm\u00e5ler',
    }));
    try {
      const rules = await import('../../packages/shared-domain/src/homeAreaConfigRules.js');
      expect(rules.findHomeAreaNameRejection({ name: ' HOVEDMA\u030aLER ', otherNames: [] }))
        .toEqual({ reason: 'name_reserved', reservedName: 'Hovedm\u00e5ler' });
    } finally {
      vi.doUnmock('../../packages/shared-domain/src/homeLimitsCopy');
      vi.doUnmock('../../packages/shared-domain/src/homeNames');
      vi.resetModules();
    }
  });

  it('judges only the name being written, never another area\'s legacy name', () => {
    // A persisted 60-character name and a persisted "Main home" must not make
    // an unrelated, compliant edit refuse.
    expect(reject('Cabin', ['b'.repeat(60), 'Main home'])).toBeNull();
  });
});

describe('composeHomeAreaSaveRefusalLine', () => {
  it('gives the reason and the control when the Main home is still on Automatic', () => {
    expect(composeHomeAreaSaveRefusalLine({ ok: false, reason: 'main_meter_required' }))
      .toBe(HOMES_AREA_NEEDS_MAIN_METER);
    // The editor does not render the standing main-meter notice, so the line
    // has to carry its own reason, not just the remedy.
    expect(HOMES_AREA_NEEDS_MAIN_METER).toContain('Automatic can’t prove which meter belongs');
    expect(HOMES_AREA_NEEDS_MAIN_METER).toContain('“Whole-home meter” under Limits & safety');
    // The picker's own side of the same rule names the panel areas live on.
    expect(HOMES_MAIN_METER_NEEDED_BY_AREAS).toContain('under Multiple meters');
  });

  it('states the id-less-aggregate situation honestly, promising nothing', () => {
    expect(composeHomeAreaSaveRefusalLine({ ok: false, reason: 'meter_unnameable' }))
      .toBe('Your whole-home meter doesn’t report a device id, and meter areas need one '
        + 'to keep homes apart. Not supported for meter areas yet.');
  });

  it('states the area cap and the way to make room', () => {
    expect(composeHomeAreaSaveRefusalLine({
      ok: false, reason: 'area_limit_reached', maxCount: HOME_AREA_MAX_COUNT,
    })).toBe(`PELS handles up to ${HOME_AREA_MAX_COUNT} meter areas. Remove one to make room.`);
  });

  it('gives each name rule its own next step', () => {
    expect(composeHomeAreaSaveRefusalLine({ ok: false, reason: 'name_required' }))
      .toBe('Give this meter area a name.');
    expect(composeHomeAreaSaveRefusalLine({ ok: false, reason: 'name_too_long', maxLength: 40 }))
      .toBe('Shorten the name to 40 characters or fewer.');
    expect(composeHomeAreaSaveRefusalLine({
      ok: false, reason: 'name_reserved', reservedName: 'Main home',
    })).toBe('“Main home” is what PELS calls the rest of your home. Give this area a different name.');
    expect(composeHomeAreaSaveRefusalLine({
      ok: false, reason: 'name_duplicate', otherName: 'Cabin',
    })).toBe('Another meter area is already named “Cabin”.');
  });

  it('reuses the shared lines for degraded, meter ownership and the shapeless refusal', () => {
    expect(composeHomeAreaSaveRefusalLine({ ok: false, reason: 'degraded' }))
      .toContain('couldn’t be read');
    expect(composeHomeAreaSaveRefusalLine({ ok: false, reason: 'meter_in_use', otherName: 'Cabin' }))
      .toBe('“Cabin” already uses this meter.');
    expect(composeHomeAreaSaveRefusalLine({ ok: false, reason: 'invalid' }))
      .toBe('Couldn’t save changes — try again.');
  });

  it('names the power-source control when an area save is refused on the Flow source', () => {
    expect(composeHomeAreaSaveRefusalLine({ ok: false, reason: 'homey_energy_required' }))
      .toBe(HOMES_AREA_NEEDS_HOMEY_ENERGY);
    // Same shape as the main-meter line: the consequence, then the control
    // named as a setting to change (the picker is on another panel).
    expect(HOMES_AREA_NEEDS_HOMEY_ENERGY).toContain('“Power source” under Limits & safety');
  });
});

describe('composePowerSourceSaveRefusalLine', () => {
  it('says the exclusion from the switch side and names the removal remedy', () => {
    expect(composePowerSourceSaveRefusalLine({ ok: false, reason: 'homey_energy_required' }))
      .toBe(HOMES_POWER_SOURCE_NEEDED_BY_AREAS);
    // The remedy the line names (deleting areas) is never itself refused, so
    // the instruction can always be followed.
    expect(HOMES_POWER_SOURCE_NEEDED_BY_AREAS).toContain('under Multiple meters first');
  });

  it('keeps degraded and unexpected reasons on their own lines', () => {
    expect(composePowerSourceSaveRefusalLine({ ok: false, reason: 'degraded' }))
      .toContain('couldn’t be read');
    // A reason this op cannot produce must not render an area instruction
    // over the power-source control.
    expect(composePowerSourceSaveRefusalLine({ ok: false, reason: 'main_meter_required' }))
      .toBe(HOMES_POWER_SOURCE_SAVE_FAILED);
  });
});

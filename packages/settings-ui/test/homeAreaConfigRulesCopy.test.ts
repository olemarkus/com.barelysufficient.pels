import { describe, expect, it } from 'vitest';
import { HOME_AREA_MAX_COUNT } from '../../shared-domain/src/homeAreaConfigRules';
import {
  composeHomeAreaSaveRefusalLine,
  composePowerSourceSaveRefusalLine,
  HOMES_AREA_NEEDS_HOMEY_ENERGY,
  HOMES_AREA_NEEDS_MAIN_METER,
  HOMES_POWER_SOURCE_NEEDED_BY_AREAS,
  HOMES_POWER_SOURCE_SAVE_FAILED,
} from '../src/ui/homeAreaConfigRulesCopy';

describe('composeHomeAreaSaveRefusalLine', () => {
  it('gives the reason and the control when the Main home has no meter persisted', () => {
    expect(composeHomeAreaSaveRefusalLine({ ok: false, reason: 'main_meter_required' }))
      .toBe(HOMES_AREA_NEEDS_MAIN_METER);
    // The editor does not render the standing main-meter notice, so the line
    // has to carry its own reason, not just the remedy.
    expect(HOMES_AREA_NEEDS_MAIN_METER).toContain('so PELS can tell the homes apart');
    expect(HOMES_AREA_NEEDS_MAIN_METER).toContain('“Whole-home meter” under Limits & safety');
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

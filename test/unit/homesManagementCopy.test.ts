// Unit coverage for the shared home-naming rule. `resolveHomeAreaDisplayName`
// is the ONE answer to "what do we call this meter area", used by the settings
// UI's Multiple meters list and by the runtime's `capacity_shortfall` Flow
// token, so a blank saved name cannot render two different ways.
import { describe, expect, it } from 'vitest';
import {
  HOMES_MAIN_HOME_NAME,
  HOMES_UNNAMED_AREA_NAME,
  composeDeleteConfirmBody,
  composeDraftErrorLine,
  resolveHomeAreaDisplayName,
} from '../../packages/shared-domain/src/homesManagementCopy';
import {
  composeHomeLimitsInactiveNotice,
  composeHomeLimitsSimulationNotice,
} from '../../packages/shared-domain/src/homeLimitsCopy';

describe('resolveHomeAreaDisplayName', () => {
  it('uses the saved area name', () => {
    expect(resolveHomeAreaDisplayName('Annex')).toBe('Annex');
  });

  it('falls back to the generic label when the persisted name is blank', () => {
    // The config store accepts any string for `name` and no write path checks
    // it, so an empty or whitespace-only name is reachable and must not surface
    // as an empty Flow tag or an empty row title.
    expect(resolveHomeAreaDisplayName('')).toBe(HOMES_UNNAMED_AREA_NAME);
    expect(resolveHomeAreaDisplayName('   ')).toBe(HOMES_UNNAMED_AREA_NAME);
  });

  it('keeps the two home labels distinct', () => {
    // The shortfall tag has to discriminate; identical labels would defeat it.
    expect(HOMES_MAIN_HOME_NAME).not.toBe(HOMES_UNNAMED_AREA_NAME);
  });
});

describe('copy composers quoting an area name', () => {
  // Every composer that quotes an area name self-resolves the blank case, so
  // no display consumer can render `“”` while another says `Meter area`.
  it('delete confirm never quotes an empty name', () => {
    expect(composeDeleteConfirmBody('Annex')).toContain('“Annex”');
    expect(composeDeleteConfirmBody('  ')).toContain(`“${HOMES_UNNAMED_AREA_NAME}”`);
  });

  it('draft error lines never quote an empty other-area name', () => {
    expect(composeDraftErrorLine({ kind: 'meter_in_use', otherName: '' }))
      .toContain(`“${HOMES_UNNAMED_AREA_NAME}”`);
    expect(composeDraftErrorLine({ kind: 'meter_in_use', otherName: HOMES_MAIN_HOME_NAME }))
      .toContain(`“${HOMES_MAIN_HOME_NAME}”`);
    expect(composeDraftErrorLine({ kind: 'zone_overlap', otherName: ' ' }))
      .toContain(`“${HOMES_UNNAMED_AREA_NAME}”`);
    expect(composeDraftErrorLine({ kind: 'name_duplicate', otherName: 'Cabin' }))
      .toContain('“Cabin”');
  });

  it('limits notices never quote an empty area name', () => {
    expect(composeHomeLimitsSimulationNotice('')).toContain(`“${HOMES_UNNAMED_AREA_NAME}”`);
    expect(composeHomeLimitsInactiveNotice('')).toContain(`“${HOMES_UNNAMED_AREA_NAME}”`);
    expect(composeHomeLimitsSimulationNotice('Annex')).toContain('“Annex”');
  });
});

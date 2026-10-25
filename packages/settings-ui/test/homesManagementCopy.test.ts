import { describe, expect, it } from 'vitest';
import { HOMES_MAIN_HOME_NAME, HOMES_UNNAMED_AREA_NAME } from '../../shared-domain/src/homeNames';
import {
  composeDeleteConfirmBody,
  composeDraftErrorLine,
} from '../src/ui/homesManagementCopy';
import { composeHomeLimitsSimulationNotice } from '../src/ui/homeLimitsCopy';

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
    expect(composeHomeLimitsSimulationNotice('Annex')).toContain('“Annex”');
  });
});

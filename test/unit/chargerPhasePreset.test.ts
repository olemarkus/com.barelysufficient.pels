import { resolveChargerPhasePresets, resolveChargerPhaseReport } from '../../lib/device/chargerPhasePreset';
import type { HomeyDeviceLike } from '../../lib/utils/types';

// Setting values as the deployed Easee app 2.0.5 decodes them (`lib/enums.js`).
const easee = (settings: Record<string, unknown>): HomeyDeviceLike => ({
  id: 'easee-1',
  name: 'Elbillader',
  ownerUri: 'homey:app:no.easee',
  driverId: 'homey:app:no.easee:charger',
  settings,
});

describe('resolveChargerPhaseReport', () => {
  it('follows a locked phase mode over the grid type', () => {
    // The production charger: locked to one phase on an IT single-phase supply.
    expect(resolveChargerPhaseReport(easee({
      phaseMode: 'Locked to single phase',
      detectedPowerGridType: 'IT_1_PHASE',
    }))).toEqual({ kind: 'reported', preset: 'ev_charger_1_phase' });
    expect(resolveChargerPhaseReport(easee({
      phaseMode: 'Locked to single phase',
      detectedPowerGridType: 'TN_3_PHASE',
    }))).toEqual({ kind: 'reported', preset: 'ev_charger_1_phase' });
    expect(resolveChargerPhaseReport(easee({
      phaseMode: 'Locked to three phase',
      detectedPowerGridType: 'IT_1_PHASE',
    }))).toEqual({ kind: 'reported', preset: 'ev_charger_3_phase' });
  });

  it('plans an auto-phase charger by its wiring', () => {
    expect(resolveChargerPhaseReport(easee({ phaseMode: 'Auto', detectedPowerGridType: 'TN_3_PHASE' })))
      .toEqual({ kind: 'reported', preset: 'ev_charger_3_phase' });
    expect(resolveChargerPhaseReport(easee({ phaseMode: 'Auto', detectedPowerGridType: 'IT_3_PHASE' })))
      .toEqual({ kind: 'reported', preset: 'ev_charger_3_phase' });
    expect(resolveChargerPhaseReport(easee({ phaseMode: 'Auto', detectedPowerGridType: 'TN_1_PHASE' })))
      .toEqual({ kind: 'reported', preset: 'ev_charger_1_phase' });
    expect(resolveChargerPhaseReport(easee({
      phaseMode: 'Auto',
      detectedPowerGridType: 'WARNING_TN_1_PHASE_NEUTRAL_ON_PIN_3',
    }))).toEqual({ kind: 'reported', preset: 'ev_charger_1_phase' });
  });

  it('reports nothing when the wiring does not name a phase count', () => {
    for (const detectedPowerGridType of [
      'NOT_YET_DETECTED',
      'TN_2_PHASE_PIN_2_3_4',
      'WARNING_TN_2_PHASE_PIN_2_3_5',
      'ERROR_NO_VALID_POWER_GRID_FOUND',
      'UNKNOWN (99)',
    ]) {
      expect(resolveChargerPhaseReport(easee({ phaseMode: 'Auto', detectedPowerGridType }))).toEqual({ kind: 'not_reported' });
    }
    expect(resolveChargerPhaseReport(easee({}))).toEqual({ kind: 'not_reported' });
  });

  it('only reads Easee settings', () => {
    expect(resolveChargerPhaseReport({
      id: 'other',
      name: 'Other charger',
      ownerUri: 'homey:app:com.example',
      settings: { phaseMode: 'Locked to single phase' },
    })).toEqual({ kind: 'not_reported' });
  });
});

describe('resolveChargerPhasePresets', () => {
  it('keys the reported mode by device id and leaves every other device out', () => {
    expect(resolveChargerPhasePresets([
      easee({ phaseMode: 'Locked to single phase' }),
      { ...easee({ phaseMode: 'Auto', detectedPowerGridType: 'NOT_YET_DETECTED' }), id: 'easee-2' },
      { id: 'heater', name: 'Heater', ownerUri: 'homey:app:com.example' },
    ])).toEqual({ 'easee-1': 'ev_charger_1_phase' });
  });
});

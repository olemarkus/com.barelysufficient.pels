import { describe, expect, it } from 'vitest';
import { resolveEaseeAutomaticProfile } from '../../lib/device/easee/automaticProfile';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const current: DeviceCapabilityMap = {
  target_charger_current: { value: 16, min: 0, max: 40, step: 1, setable: true },
};
const charger = (settings: HomeyDeviceLike['settings']): HomeyDeviceLike => ({ ...HOMEY_DEVICE_FIELDS,
  id: 'easee', name: 'Easee', settings,
});

describe('Easee integration-derived power levels', () => {
  it.each([
    ['TN_1_PHASE', 230],
    ['IT_1_PHASE', 230],
    ['WARNING_TN_1_PHASE_NEUTRAL_ON_PIN_3', 230],
    ['TN_3_PHASE', 690],
    ['IT_3_PHASE', Math.sqrt(3) * 230],
  ] as const)('derives physical whole-amp levels for %s', (grid, wattsPerAmp) => {
    const profile = resolveEaseeAutomaticProfile(charger({
      detectedPowerGridType: grid, phaseMode: 'Auto', maxChargerCurrent: '32', circuitFuse: '25',
    }), current);
    expect(profile?.steps[0]).toEqual({ id: 'off', planningPowerW: 0, planningCurrentA: 0 });
    expect(profile?.steps[1]).toEqual({
      id: '6a', planningPowerW: Math.round(6 * wattsPerAmp), planningCurrentA: 6,
    });
    expect(profile?.steps.at(-1)).toEqual({
      id: '25a', planningPowerW: Math.round(25 * wattsPerAmp), planningCurrentA: 25,
    });
    expect(profile?.steps).toHaveLength(21);
  });

  it('uses a locked single phase on a three-phase grid', () => {
    const profile = resolveEaseeAutomaticProfile(charger({
      detectedPowerGridType: 'IT_3_PHASE', phaseMode: 'Locked to single phase', maxChargerCurrent: '16',
    }), current);
    expect(profile?.steps.at(-1)?.planningPowerW).toBe(3680);
  });

  it.each(['NOT_YET_DETECTED', 'TN_2_PHASE_PIN_2_3_4', 'UNKNOWN (9)', undefined])(
    'does not invent a model for grid %s', (grid) => {
      expect(resolveEaseeAutomaticProfile(charger({ detectedPowerGridType: grid }), current)).toBeUndefined();
    },
  );

  it.each([
    { max: undefined }, { max: 0 }, { max: 5 }, { max: Number.NaN },
    { setable: false }, { step: 0 }, { step: 0.5 }, { min: 6 },
  ])('requires usable current limits %j', (options) => {
    expect(resolveEaseeAutomaticProfile(charger({ detectedPowerGridType: 'TN_3_PHASE' }), {
      target_charger_current: { ...current.target_charger_current, ...options },
    })).toBeUndefined();
  });

  it('waits for a malformed published installation limit instead of ignoring it', () => {
    expect(resolveEaseeAutomaticProfile(charger({
      detectedPowerGridType: 'TN_3_PHASE', maxChargerCurrent: 'unavailable',
    }), current)).toBeUndefined();
  });
});

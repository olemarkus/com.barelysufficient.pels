import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices.ts';
import type { PowerFigureCheck } from '../../contracts/src/powerFigureCheck.ts';
import { resolvePowerFigureRecommendations } from '../src/ui/powerFigureRecommendations.ts';

const device = (check: PowerFigureCheck | undefined, overrides: Partial<SettingsUiDeviceSnapshot> = {}) => ({
  id: 'vvb',
  name: 'VVB',
  available: true,
  expectedPowerKw: check?.figureKw ?? 2,
  expectedPowerSource: 'measured-peak',
  targets: [],
  ...(check ? { powerFigureCheck: check } : {}),
  ...overrides,
} as SettingsUiDeviceSnapshot);

const recommend = (check: PowerFigureCheck, overrides: Partial<SettingsUiDeviceSnapshot> = {}) => {
  const [recommendation] = resolvePowerFigureRecommendations([device(check, overrides)]);
  return recommendation;
};

describe('power figure recommendations', () => {
  it('offers the measured figure for a figure PELS can replace', () => {
    const recommendation = recommend({ measuredKw: 4.465, figureKw: 2.6, figure: 'device_reading' });
    expect(recommendation).toEqual(expect.objectContaining({
      id: 'power-figure:vvb', version: 26, category: 'recommendation',
      title: 'Check the power for VVB',
      actionLabel: 'Use 4.5 kW',
      target: { kind: 'expected-power', deviceId: 'vvb', kw: 4.5 },
    }));
    expect(recommendation?.body).toContain('VVB reports 2.6 kW while it runs, but your home drops about 4.5 kW');
    expect(recommendation?.body).toContain('If 2.6 kW is right, dismiss this.');
    for (const figure of ['typed', 'load_setting', 'homey_energy', 'default'] as const) {
      expect(recommend({ measuredKw: 3, figureKw: 0.4, figure })).toEqual(expect.objectContaining({
        actionLabel: 'Use 3.0 kW', target: { kind: 'expected-power', deviceId: 'vvb', kw: 3 },
      }));
    }
  });

  it('keeps a dismissal while the figure stands, however the measured median moves', () => {
    const before = recommend({ measuredKw: 4.46, figureKw: 2.6, figure: 'typed' });
    const after = recommend({ measuredKw: 4.53, figureKw: 2.6, figure: 'typed' });
    const changed = recommend({ measuredKw: 4.53, figureKw: 3, figure: 'typed' });
    expect(after?.version).toBe(before?.version);
    expect(changed?.version).not.toBe(before?.version);
  });

  it('sends a Flow-set figure to its Flow instead of overwriting it', () => {
    const recommendation = recommend({ measuredKw: 3, figureKw: 2, figure: 'flow' });
    expect(recommendation).toEqual(expect.objectContaining({
      actionLabel: 'Open device', target: { kind: 'device', deviceId: 'vvb', focus: 'expected-power' },
    }));
    expect(recommendation?.body).toContain('a Flow sets its figure to 2.0 kW');
  });

  it('sends levels below the device draw to the levels, in watts below 1 kW', () => {
    const recommendation = recommend(
      { measuredKw: 0.9, figureKw: 0.2, figure: 'highest_level' },
      { name: 'Termostat Bad', targets: [{ id: 'target_temperature', value: 22, unit: '°C' }] } as Partial<SettingsUiDeviceSnapshot>,
    );
    expect(recommendation).toEqual(expect.objectContaining({
      actionLabel: 'Review levels', target: { kind: 'device', deviceId: 'vvb', focus: 'levels' },
    }));
    expect(recommendation?.body).toContain('has drawn up to 900 W, but its highest level is 200 W');
  });

  it('says nothing for a device PELS does not doubt, and never uses an em dash', () => {
    expect(resolvePowerFigureRecommendations([device(undefined)])).toEqual([]);
    for (const figure of ['typed', 'flow', 'load_setting', 'homey_energy', 'device_reading', 'default', 'highest_level'] as const) {
      expect(recommend({ measuredKw: 3, figureKw: 1, figure })?.body).not.toContain('—');
    }
  });
});

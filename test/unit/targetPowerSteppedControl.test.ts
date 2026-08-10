import { describe, expect, it } from 'vitest';
import { resolveTargetPowerSteppedControl } from '../../lib/device/nativeSteppedLoadWiring';

describe('resolveTargetPowerSteppedControl', () => {
  it('returns the config and its ladder together', () => {
    const config = { enabled: true, min: 0, max: 1500, step: 500 };

    const control = resolveTargetPowerSteppedControl(config);

    expect(control?.config).toBe(config);
    expect(control?.profile.steps).toEqual([
      { id: 'off', planningPowerW: 0 },
      { id: '500w', planningPowerW: 500 },
      { id: '1000w', planningPowerW: 1000 },
      { id: '1500w', planningPowerW: 1500 },
    ]);
  });

  it('builds the EV preset ladder from the confirmed reach', () => {
    const control = resolveTargetPowerSteppedControl(
      { enabled: true, preset: 'ev_charger_1_phase' },
      3680,
    );

    expect(control?.profile.steps.at(-1)?.planningPowerW).toBe(3680);
    expect(control?.profile.steps.some((step) => step.planningPowerW > 0)).toBe(true);
  });

  it('is not stepped control at all when there is no config or it is switched off', () => {
    expect(resolveTargetPowerSteppedControl(undefined)).toBeUndefined();
    expect(resolveTargetPowerSteppedControl({ enabled: false, max: 1500, step: 500 }))
      .toBeUndefined();
  });

  it('kills the whole stepped control when the range yields no ladder', () => {
    // The point of the pairing: there is no return shape that carries a config
    // with an absent ladder, so a caller cannot classify this device as stepped.
    expect(resolveTargetPowerSteppedControl({ enabled: true, max: 100, step: 500 }))
      .toBeUndefined();
    expect(resolveTargetPowerSteppedControl({ enabled: true, max: 0, step: 500 }))
      .toBeUndefined();
    expect(resolveTargetPowerSteppedControl({ enabled: true }))
      .toBeUndefined();
  });
});

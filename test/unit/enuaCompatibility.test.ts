import { describe, expect, it } from 'vitest';
import { getDeviceAdapter } from '../../lib/device/deviceAdapterRegistry';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const values = { target_power: { value: 11040, min: 0, max: 22080, step: 230, setable: true } };
const charger = (grid_type?: string): HomeyDeviceLike => ({
  id: 'enua', name: 'Enua Charge', driverId: 'homey:app:no.enua:enua-charger',
  settings: grid_type === undefined ? {} : { grid_type }, capabilities: ['target_power'], capabilitiesObj: values,
});

describe('Enua shipped capability compatibility', () => {
  it.each([
    ['1phase', 230], ['tn_3phase', 690], ['it_3phase', Math.sqrt(3) * 230],
    [undefined, 690], ['unknown', 690],
  ])('matches the vendor conversion for %s without changing the observation', (grid, step) => {
    const device = charger(grid as string | undefined);
    const overlay = getDeviceAdapter(device).overlay(device, device.capabilities!, values);
    expect(overlay.capabilityObj.target_power).toEqual({
      ...values.target_power, step, max: 32 * Number(step), excludeMin: 0, excludeMax: 6 * Number(step),
    });
    expect(values.target_power).toEqual({ value: 11040, min: 0, max: 22080, step: 230, setable: true });
  });

  it('preserves corrected upstream metadata and a lower installation ceiling', () => {
    const device = charger('tn_3phase');
    const corrected = { target_power: { ...values.target_power, max: 11040, step: 690, excludeMin: 0, excludeMax: 4140 } };
    expect(getDeviceAdapter(device).overlay(device, device.capabilities!, corrected).capabilityObj).toBe(corrected);
  });

  it('does not claim a read-only or missing power control', () => {
    const device = charger('1phase');
    const adapter = getDeviceAdapter(device);
    expect(adapter.overlay(device, [], {}).kind).toBe('standard');
    expect(adapter.overlay(device, ['target_power'], {
      target_power: { ...values.target_power, setable: false },
    }).kind).toBe('standard');
  });

  it('leaves an unrelated charger with identical capabilities unchanged', () => {
    const device = { ...charger('1phase'), driverId: 'homey:app:other:charger' };
    expect(getDeviceAdapter(device).overlay(device, device.capabilities!, values).capabilityObj).toBe(values);
  });

  it.each([
    ['1phase', 230], ['tn_3phase', 690], ['it_3phase', Math.sqrt(3) * 230],
  ] as const)('resolves saved limits and converts car-phase watts through amps on %s', (grid, gridWatts) => {
    const device = charger(grid);
    const adapter = getDeviceAdapter(device);
    const saved = { enabled: true, min: 0, max: 22080, step: 230 };
    expect(adapter.configureTargetPower(device, saved)).toMatchObject({
      min: 0, max: 32 * gridWatts, step: gridWatts, excludeMax: 6 * gridWatts,
    });
    expect(saved).toEqual({ enabled: true, min: 0, max: 22080, step: 230 });
    for (const [preset, carWatts] of [['ev_charger_1_phase', 230], ['ev_charger_3_phase', 690]] as const) {
      const config = { enabled: true, preset };
      expect(adapter.targetPowerReading(device, config, 32 * gridWatts)).toBe(32 * carWatts);
      expect(adapter.stepCommand(device, { id: '10a', planningPowerW: 10 * carWatts, planningCurrentA: 10 },
        { capabilityId: 'target_power', value: 10 * carWatts })).toEqual({
        capabilityId: 'target_power', value: Math.round(10 * gridWatts),
      });
      expect(adapter.configureTargetPower(device, { ...config, max: 5 * carWatts }).max).toBe(5 * carWatts);
      for (let amps = 6; amps <= 32; amps += 1) {
        const command = adapter.stepCommand(device,
          { id: `${amps}a`, planningPowerW: amps * carWatts, planningCurrentA: amps },
          { capabilityId: 'target_power', value: amps * carWatts });
        expect(adapter.targetPowerReading(device, config, Number(command.value))).toBe(amps * carWatts);
      }
      expect(adapter.targetPowerReading(device, config, 8.5 * gridWatts)).toBe(8.5 * carWatts);
    }
  });
});

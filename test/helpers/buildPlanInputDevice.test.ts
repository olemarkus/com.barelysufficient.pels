import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { buildPlanInputDevice } from './buildPlanInputDevice';

describe('buildPlanInputDevice', () => {
  it('applies the documented defaults when only id is provided', () => {
    const device = buildPlanInputDevice({ id: 'dev-1' });

    expect(device).toEqual({
      id: 'dev-1',
      name: 'dev-1',
      targets: [],
      currentOn: true,
    });
  });

  it('lets overrides win over the defaults', () => {
    const device = buildPlanInputDevice({
      id: 'dev-2',
      name: 'Living room heater',
      currentOn: false,
    });

    expect(device.id).toBe('dev-2');
    expect(device.name).toBe('Living room heater');
    expect(device.currentOn).toBe(false);
    expect(device.targets).toEqual([]);
  });

  it('passes through optional fields unchanged and leaves unspecified ones undefined', () => {
    const device = buildPlanInputDevice({
      id: 'dev-3',
      deviceClass: 'evcharger',
      controlCapabilityId: 'evcharger_charging',
      priority: 4,
      powerKw: 7.2,
    });

    expect(device.deviceClass).toBe('evcharger');
    expect(device.controlCapabilityId).toBe('evcharger_charging');
    expect(device.priority).toBe(4);
    expect(device.powerKw).toBe(7.2);
    // Sanity: unrelated optionals stay absent rather than being defaulted.
    expect(device.expectedPowerKw).toBeUndefined();
    expect(device.evChargingState).toBeUndefined();
  });

  it('replaces the default targets array when an override is supplied', () => {
    const targets: PlanInputDevice['targets'] = [
      { id: 'target_temperature', unit: 'C', value: 65 },
    ];

    const device = buildPlanInputDevice({ id: 'dev-4', targets });

    expect(device.targets).toBe(targets);
  });
});

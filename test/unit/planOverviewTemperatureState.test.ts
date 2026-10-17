import { resolveOverviewTemperatureFacet } from '../../lib/plan/planOverviewTemperatureState';
import { buildPlanDevice } from '../utils/planTestUtils';

describe('resolveOverviewTemperatureFacet', () => {
  it('combines the observer current pair and direction with the planner target', () => {
    const device = buildPlanDevice({
      deviceType: 'temperature',
      currentTarget: 16,
      currentTemperature: 18,
      plannedTarget: 21,
    });

    expect(resolveOverviewTemperatureFacet(device, {
      kind: 'observed',
      value: { currentTarget: 17, currentTemperature: 20.5 },
    }, 'cooling')).toEqual({
      kind: 'present',
      value: { currentTarget: 17, currentTemperature: 20.5, plannedTarget: 21, thermalDirection: 'cooling' },
    });
  });

  it('keeps observed temperature presentation for a binary-controlled thermostat', () => {
    const device = buildPlanDevice({ deviceType: 'onoff' });

    expect(resolveOverviewTemperatureFacet(device, {
      kind: 'observed',
      value: { currentTarget: 22, currentTemperature: 20.3 },
    }, 'heating')).toEqual({
      kind: 'present',
      value: { currentTarget: 22, currentTemperature: 20.3, plannedTarget: 22, thermalDirection: 'heating' },
    });
  });

  it('trusts explicit observer absence instead of reviving the plan snapshot', () => {
    const device = buildPlanDevice({
      deviceType: 'temperature',
      currentTarget: 21,
      currentTemperature: 20,
      plannedTarget: 21,
    });

    expect(resolveOverviewTemperatureFacet(device, { kind: 'absent' }, 'heating')).toEqual({ kind: 'absent' });
  });

});
